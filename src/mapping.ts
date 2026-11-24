// Translates the resources of a Pulumi plan (`pulumi preview --json`) into money a
// month. The cluster is a local kind, which bills nothing; the price is what the same
// requests would cost as AWS Fargate pods, plus the two Kubernetes objects that turn
// into a bill on any cloud — a LoadBalancer Service and a PersistentVolumeClaim.
// Rates and their source are declared in README, "## CI/CD"; the gate checks the
// mechanics, not the precision of a price list.

export const RATES = {
  // AWS Fargate, Linux/x86, us-east-1 — https://aws.amazon.com/fargate/pricing/
  vcpuHourUsd: 0.04048,
  gbHourUsd: 0.004445,
  // Network Load Balancer hour — https://aws.amazon.com/elasticloadbalancing/pricing/
  loadBalancerHourUsd: 0.0225,
  // EBS gp3, GB-month — https://aws.amazon.com/ebs/pricing/
  volumeGbMonthUsd: 0.08,
  hoursPerMonth: 730,
} as const;

export interface PlanStep {
  op: string;
  urn: string;
  oldState?: { type: string; inputs?: Record<string, unknown> };
  newState?: { type: string; inputs?: Record<string, unknown> };
}

export interface Plan {
  steps?: PlanStep[];
}

export interface CostLine {
  urn: string;
  type: string;
  usd: number;
}

// The steps that leave nothing behind: their newState (if any) is not part of the result.
const GONE = new Set(['delete', 'delete-replaced', 'discard', 'discard-replaced', 'remove-pending-replace']);

export function cpuCores(quantity: unknown): number {
  const q = String(quantity ?? '0');
  return q.endsWith('m') ? Number(q.slice(0, -1)) / 1000 : Number(q);
}

const MEMORY_UNITS: Record<string, number> = {
  Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12,
};

export function gibibytes(quantity: unknown): number {
  const m = /^([0-9.]+)([A-Za-z]*)$/.exec(String(quantity ?? '0'));
  if (!m) return 0;
  const bytes = Number(m[1]) * (m[2] ? MEMORY_UNITS[m[2]] ?? NaN : 1);
  return bytes / 2 ** 30;
}

type Obj = Record<string, any>;

function podMonthlyUsd(podSpec: Obj | undefined): number {
  let cores = 0;
  let gib = 0;
  for (const c of (podSpec?.containers ?? []) as Obj[]) {
    cores += cpuCores(c.resources?.requests?.cpu);
    gib += gibibytes(c.resources?.requests?.memory);
  }
  return (cores * RATES.vcpuHourUsd + gib * RATES.gbHourUsd) * RATES.hoursPerMonth;
}

export function monthlyUsd(type: string, inputs: Obj = {}): number {
  switch (type) {
    case 'kubernetes:apps/v1:Deployment':
    case 'kubernetes:apps/v1:StatefulSet':
      return (inputs.spec?.replicas ?? 1) * podMonthlyUsd(inputs.spec?.template?.spec);
    case 'kubernetes:core/v1:Service':
      return inputs.spec?.type === 'LoadBalancer' ? RATES.loadBalancerHourUsd * RATES.hoursPerMonth : 0;
    case 'kubernetes:core/v1:PersistentVolumeClaim':
      return gibibytes(inputs.spec?.resources?.requests?.storage) * RATES.volumeGbMonthUsd;
    default:
      return 0;
  }
}

// Cost of the state the plan leads to (plan) and of the state it starts from (base).
export function planCost(plan: Plan): { planUsd: number; baseUsd: number; lines: CostLine[] } {
  const after = new Map<string, CostLine>();
  const before = new Map<string, number>();
  for (const step of plan.steps ?? []) {
    if (step.oldState) before.set(step.urn, monthlyUsd(step.oldState.type, step.oldState.inputs));
    if (step.newState && !GONE.has(step.op)) {
      after.set(step.urn, { urn: step.urn, type: step.newState.type, usd: monthlyUsd(step.newState.type, step.newState.inputs) });
    }
    if (GONE.has(step.op)) after.delete(step.urn);
  }
  const lines = [...after.values()];
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return { planUsd: sum(lines.map((l) => l.usd)), baseUsd: sum([...before.values()]), lines };
}
