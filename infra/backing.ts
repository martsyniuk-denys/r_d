import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

// The two services the API cannot run without, inside the cluster: Postgres for the
// data and RabbitMQ for the outbox → consumer leg. One replica each, a StatefulSet
// each, so the data sits on a PersistentVolumeClaim (kind's local-path) and a pod
// restart is not a fresh database. The Service names are the host names the app's
// URLs carry: postgres:5432, rabbitmq:5672.
//
// Not here, on purpose: pgbouncer (the API's own pool is enough for three replicas),
// Redis and object storage (no route of the main contour touches them). See README,
// "Kubernetes: the full contour".

export interface BackingArgs {
  namespace: pulumi.Input<string>;
  // The K8s Secret with DB_PASSWORD and BROKER_PASSWORD, shared with the app.
  secretName: pulumi.Input<string>;
}

export const DB_USER = 'marketplace';
export const DB_NAME = 'marketplace';
export const BROKER_USER = 'marketplace';

const VOLUME_SIZE = '1Gi';

function headlessService(
  name: string,
  port: number,
  args: BackingArgs,
  opts: pulumi.CustomResourceOptions,
): k8s.core.v1.Service {
  return new k8s.core.v1.Service(
    name,
    {
      metadata: { name, namespace: args.namespace, labels: { app: name } },
      spec: { clusterIP: 'None', selector: { app: name }, ports: [{ name, port, targetPort: port }] },
    },
    opts,
  );
}

export function postgres(args: BackingArgs, opts: pulumi.CustomResourceOptions): k8s.apps.v1.StatefulSet {
  const name = 'postgres';
  const service = headlessService(name, 5432, args, opts);
  return new k8s.apps.v1.StatefulSet(
    name,
    {
      metadata: { name, namespace: args.namespace, labels: { app: name } },
      spec: {
        serviceName: service.metadata.name,
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            // uid 70 is `postgres` in the alpine image; fsGroup hands it the volume.
            securityContext: { runAsUser: 70, runAsGroup: 70, fsGroup: 70, runAsNonRoot: true },
            containers: [
              {
                name,
                image: 'postgres:16-alpine',
                ports: [{ name, containerPort: 5432 }],
                env: [
                  { name: 'POSTGRES_USER', value: DB_USER },
                  { name: 'POSTGRES_DB', value: DB_NAME },
                  // The image reads the password from a file: no value in the pod spec.
                  { name: 'POSTGRES_PASSWORD_FILE', value: '/run/secrets/db/DB_PASSWORD' },
                  // A subdirectory: the volume's root holds lost+found on some drivers.
                  { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' },
                ],
                // Over TCP, not the socket: during initdb the image runs a temporary
                // server on the socket only, which must not count as ready.
                readinessProbe: {
                  exec: { command: ['pg_isready', '-h', '127.0.0.1', '-U', DB_USER, '-d', DB_NAME] },
                  periodSeconds: 2,
                  failureThreshold: 3,
                  timeoutSeconds: 2,
                },
                resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '512Mi' } },
                volumeMounts: [
                  { name: 'data', mountPath: '/var/lib/postgresql/data' },
                  { name: 'db-password', mountPath: '/run/secrets/db', readOnly: true },
                ],
              },
            ],
            volumes: [
              {
                name: 'db-password',
                secret: { secretName: args.secretName, items: [{ key: 'DB_PASSWORD', path: 'DB_PASSWORD' }], defaultMode: 0o440 },
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: 'data' },
            spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: VOLUME_SIZE } } },
          },
        ],
      },
    },
    opts,
  );
}

export function rabbitmq(args: BackingArgs, opts: pulumi.CustomResourceOptions): k8s.apps.v1.StatefulSet {
  const name = 'rabbitmq';
  const service = headlessService(name, 5672, args, opts);
  return new k8s.apps.v1.StatefulSet(
    name,
    {
      metadata: { name, namespace: args.namespace, labels: { app: name } },
      spec: {
        // A StatefulSet for the stable host name as much as for the volume: the node
        // is rabbit@<hostname>, and its data directory is only its own under that name.
        serviceName: service.metadata.name,
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            securityContext: { runAsUser: 999, runAsGroup: 999, fsGroup: 999, runAsNonRoot: true },
            containers: [
              {
                name,
                image: 'rabbitmq:4.2-alpine',
                ports: [{ name: 'amqp', containerPort: 5672 }],
                env: [
                  { name: 'RABBITMQ_DEFAULT_USER', value: BROKER_USER },
                  // By reference: the manifest names the Secret, not the value.
                  {
                    name: 'RABBITMQ_DEFAULT_PASS',
                    valueFrom: { secretKeyRef: { name: args.secretName, key: 'BROKER_PASSWORD' } },
                  },
                ],
                // check_running, as in compose: past the window where the port is open
                // but basic.publish still gets ECONNRESET.
                readinessProbe: {
                  exec: { command: ['rabbitmq-diagnostics', '-q', 'check_running'] },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                  failureThreshold: 3,
                  timeoutSeconds: 10,
                },
                resources: { requests: { cpu: '50m', memory: '192Mi' }, limits: { memory: '512Mi' } },
                volumeMounts: [{ name: 'data', mountPath: '/var/lib/rabbitmq' }],
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: 'data' },
            spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: VOLUME_SIZE } } },
          },
        ],
      },
    },
    opts,
  );
}
