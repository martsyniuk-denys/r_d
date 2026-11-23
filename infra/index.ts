import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { DB_NAME, DB_USER, BROKER_USER, postgres, rabbitmq } from './backing';
import { APP_SECRETS, loadSettings } from './config';

// First action of the program: validate. Nothing below runs without the secrets.
const settings = loadSettings();

const DRAIN_MS = 5_000;
// Longer than the drain plus the close of the remaining sockets, so SIGKILL never
// lands in the middle of a drain (exit 137, cut connections).
const GRACE_SECONDS = 15;
const PORT = 3000;
const METRICS_PORT = 9464;

const safe = settings.profile === 'safe';
const labels = { app: settings.name };

const provider = new k8s.Provider('kind', {
  context: settings.kubeContext,
  enableServerSideApply: true,
});
const opts: pulumi.CustomResourceOptions = { provider };

const namespace = new k8s.core.v1.Namespace(
  'ns',
  { metadata: { name: settings.namespace } },
  opts,
);
const ns = namespace.metadata.name;

// `data`, base64, rather than `stringData`: stringData is write-only, the API never
// returns it, and the provider would report a diff on every `up`.
const base64 = (value: pulumi.Output<string>) => value.apply((v) => Buffer.from(v, 'utf8').toString('base64'));
const appSecret = new k8s.core.v1.Secret(
  'app',
  {
    metadata: { name: `${settings.name}-secrets`, namespace: ns },
    type: 'Opaque',
    data: {
      DB_PASSWORD: base64(settings.dbPassword),
      ...Object.fromEntries(APP_SECRETS.map((name) => [name, base64(settings.appSecrets[name])])),
    },
  },
  opts,
);

const backing = { namespace: ns, secretName: appSecret.metadata.name };
const db = postgres(backing, opts);
const broker = rabbitmq(backing, opts);

// The app's side of the Secret: one file per key under SECRETS_DIR, and the NAME_FILE
// variables the app already reads in compose (src/config/secret-files.ts). The pod
// spec carries paths; `kubectl get deploy -o yaml` shows no value.
const SECRETS_DIR = '/run/secrets/app';
const secretFile = (name: string) => ({ name: `${name}_FILE`, value: `${SECRETS_DIR}/${name}` });
const appEnv: k8s.types.input.core.v1.EnvVar[] = [
  { name: 'NODE_ENV', value: 'production' },
  { name: 'DB_URL', value: `postgres://${DB_USER}@postgres:5432/${DB_NAME}` },
  secretFile('DB_PASSWORD'),
  { name: 'DB_POOL_MAX', value: '5' },
  { name: 'BROKER_URL', value: `amqp://${BROKER_USER}@rabbitmq:5672` },
  secretFile('BROKER_PASSWORD'),
  // Files are not deployed here (no object storage in the cluster); the API starts
  // without the bucket and says so in a warning — the contour never touches it.
  { name: 'STORAGE_ENDPOINT', value: 'http://storage:9000' },
  { name: 'STORAGE_BUCKET', value: 'marketplace-files' },
  { name: 'STORAGE_ACCESS_KEY', value: 'marketplace' },
  ...APP_SECRETS.filter((name) => name !== 'BROKER_PASSWORD').map(secretFile),
];
const appVolume: k8s.types.input.core.v1.Volume = {
  name: 'secrets',
  secret: { secretName: appSecret.metadata.name, defaultMode: 0o440 },
};
const appMount: k8s.types.input.core.v1.VolumeMount = { name: 'secrets', mountPath: SECRETS_DIR, readOnly: true };
// fsGroup: the Secret's files are root:65532 0440 — readable by the app, by no one else.
const podSecurity: k8s.types.input.core.v1.PodSecurityContext = {
  runAsNonRoot: true,
  runAsUser: 65532,
  runAsGroup: 65532,
  fsGroup: 65532,
  seccompProfile: { type: 'RuntimeDefault' },
};
const containerSecurity: k8s.types.input.core.v1.SecurityContext = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ['ALL'] },
};

// Migrations and the idempotent seed, once per image: the pod template names the
// image by digest, a Job's template is immutable, so a new image is a new Job.
// Auto-named for that reason. `pulumi up` waits for it to complete, and everything
// that reads the schema depends on it.
const migrate = new k8s.batch.v1.Job(
  'migrate',
  {
    metadata: { namespace: ns, labels: { app: `${settings.name}-migrate` } },
    spec: {
      backoffLimit: 6,
      template: {
        metadata: { labels: { app: `${settings.name}-migrate` } },
        spec: {
          restartPolicy: 'OnFailure',
          securityContext: podSecurity,
          containers: [
            {
              name: 'migrate',
              image: settings.image,
              imagePullPolicy: 'IfNotPresent',
              args: ['dist/migrate.js'],
              env: appEnv,
              resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { memory: '256Mi' } },
              securityContext: containerSecurity,
              volumeMounts: [appMount],
            },
          ],
          volumes: [appVolume],
        },
      },
    },
  },
  { ...opts, dependsOn: [db] },
);
const afterMigrations: pulumi.CustomResourceOptions = { ...opts, dependsOn: [migrate, broker] };

const probes: Pick<k8s.types.input.core.v1.Container, 'readinessProbe' | 'livenessProbe'> = safe
  ? {
      // "May I get traffic?" — asked every second; one red answer takes the pod out.
      readinessProbe: {
        httpGet: { path: '/readyz', port: PORT },
        periodSeconds: 1,
        failureThreshold: 1,
        successThreshold: 1,
        timeoutSeconds: 1,
      },
      // "Should I be killed?" — a different URL: a pod that is draining or warming up
      // is not ready, and that must never turn into a restart loop.
      livenessProbe: {
        httpGet: { path: '/healthz', port: PORT },
        initialDelaySeconds: 10,
        periodSeconds: 10,
        failureThreshold: 3,
        timeoutSeconds: 2,
      },
    }
  : {};

const deployment = new k8s.apps.v1.Deployment(
  'api',
  {
    metadata: { name: settings.name, namespace: ns, labels },
    spec: {
      // Kept on purpose: kind has no metrics-server, so the HPA never writes this
      // field here. With metrics-server it would — see README, "replicas vs HPA".
      replicas: settings.replicas,
      selector: { matchLabels: labels },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: safe ? { maxUnavailable: 0, maxSurge: 1 } : { maxUnavailable: 1, maxSurge: 1 },
      },
      template: {
        metadata: { labels },
        spec: {
          terminationGracePeriodSeconds: GRACE_SECONDS,
          securityContext: podSecurity,
          containers: [
            {
              name: 'api',
              image: settings.image,
              imagePullPolicy: 'IfNotPresent',
              args: ['dist/main.js'],
              ports: [{ name: 'http', containerPort: PORT }],
              env: [
                { name: 'PORT', value: String(PORT) },
                { name: 'REV', value: settings.rev },
                { name: 'SHUTDOWN_DRAIN_MS', value: safe ? String(DRAIN_MS) : '0' },
                ...appEnv,
              ],
              ...probes,
              resources: {
                requests: { cpu: '50m', memory: '128Mi' },
                limits: { memory: '384Mi' },
              },
              securityContext: containerSecurity,
              volumeMounts: [appMount],
            },
          ],
          volumes: [appVolume],
        },
      },
    },
  },
  afterMigrations,
);

// The background half of the contour: outbox → broker, and order.placed → confirmed.
// One replica each is a choice, not a limit — the relay claims rows with SKIP LOCKED
// and the consumer is idempotent, so more would only share the work.
function worker(role: 'relay' | 'consumer'): k8s.apps.v1.Deployment {
  const workerLabels = { app: `${settings.name}-${role}` };
  return new k8s.apps.v1.Deployment(
    role,
    {
      metadata: { name: `${settings.name}-${role}`, namespace: ns, labels: workerLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: workerLabels },
        template: {
          metadata: { labels: workerLabels },
          spec: {
            terminationGracePeriodSeconds: GRACE_SECONDS,
            securityContext: podSecurity,
            containers: [
              {
                name: role,
                image: settings.image,
                imagePullPolicy: 'IfNotPresent',
                args: [`dist/${role}.js`],
                ports: [{ name: 'metrics', containerPort: METRICS_PORT }],
                env: [{ name: 'METRICS_PORT', value: String(METRICS_PORT) }, ...appEnv],
                resources: { requests: { cpu: '25m', memory: '96Mi' }, limits: { memory: '256Mi' } },
                securityContext: containerSecurity,
                volumeMounts: [appMount],
              },
            ],
            volumes: [appVolume],
          },
        },
      },
    },
    afterMigrations,
  );
}
const relay = worker('relay');
const consumer = worker('consumer');

const service = new k8s.core.v1.Service(
  'api',
  {
    metadata: { name: settings.name, namespace: ns, labels },
    spec: {
      type: 'NodePort',
      selector: labels,
      ports: [{ name: 'http', port: 80, targetPort: PORT, nodePort: settings.nodePort }],
    },
  },
  opts,
);

// maxUnavailable rather than minAvailable: it stays "one at a time" whatever the
// HPA does to the replica count, while minAvailable: 2 at two replicas is a PDB
// that blocks every drain.
const pdb = new k8s.policy.v1.PodDisruptionBudget(
  'api',
  {
    metadata: { name: settings.name, namespace: ns },
    spec: { maxUnavailable: 1, selector: { matchLabels: labels } },
  },
  opts,
);

const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
  'api',
  {
    metadata: { name: settings.name, namespace: ns },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: deployment.metadata.name },
      minReplicas: 2,
      maxReplicas: 6,
      metrics: [
        {
          type: 'Resource',
          resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } },
        },
      ],
    },
  },
  opts,
);

export const namespaceName = ns;
export const deploymentName = deployment.metadata.name;
export const serviceName = service.metadata.name;
export const pdbName = pdb.metadata.name;
export const hpaName = hpa.metadata.name;
export const secretName = appSecret.metadata.name;
export const migrateJobName = migrate.metadata.name;
export const workerNames = [relay.metadata.name, consumer.metadata.name];
export const backingNames = [db.metadata.name, broker.metadata.name];
export const profile = settings.profile;
export const rev = settings.rev;
export const url = `http://127.0.0.1:${settings.nodePort}/`;
