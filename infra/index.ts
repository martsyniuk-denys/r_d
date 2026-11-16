import * as k8s from '@pulumi/kubernetes';
import * as pulumi from '@pulumi/pulumi';

import { loadSettings } from './config';

// First action of the program: validate. Nothing below runs without DB_PASSWORD.
const settings = loadSettings();

const DRAIN_MS = 5_000;
const WARMUP_MS = 4_000;
// Longer than the drain plus the close of the remaining sockets, so SIGKILL never
// lands in the middle of a drain (exit 137, cut connections).
const GRACE_SECONDS = 15;
const PORT = 3000;

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
const dbSecret = new k8s.core.v1.Secret(
  'db',
  {
    metadata: { name: `${settings.name}-db`, namespace: ns },
    type: 'Opaque',
    data: { DB_PASSWORD: settings.dbPassword.apply((v) => Buffer.from(v, 'utf8').toString('base64')) },
  },
  opts,
);

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
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'api',
              image: settings.image,
              imagePullPolicy: 'IfNotPresent',
              ports: [{ name: 'http', containerPort: PORT }],
              env: [
                { name: 'PORT', value: String(PORT) },
                { name: 'REV', value: settings.rev },
                { name: 'WARMUP_MS', value: String(WARMUP_MS) },
                { name: 'DRAIN_MS', value: safe ? String(DRAIN_MS) : '0' },
                {
                  name: 'DB_PASSWORD',
                  valueFrom: { secretKeyRef: { name: dbSecret.metadata.name, key: 'DB_PASSWORD' } },
                },
              ],
              ...probes,
              resources: {
                requests: { cpu: '50m', memory: '64Mi' },
                limits: { memory: '192Mi' },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
            },
          ],
        },
      },
    },
  },
  opts,
);

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
export const secretName = dbSecret.metadata.name;
export const profile = settings.profile;
export const rev = settings.rev;
export const url = `http://127.0.0.1:${settings.nodePort}/`;
