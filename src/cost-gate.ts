// npm run gate:cost — the cost gate over a Pulumi plan.
//
//   PLAN_JSON=plan.json [BASE_PLAN_JSON=base-plan.json] [COST_BUDGET_USD=…]
//   [COST_BYPASS_LABEL=cost-approved] npm run gate:cost
//
// plan-usd is computed from PLAN_JSON through src/mapping.ts. The budget is
// COST_BUDGET_USD when given; otherwise it follows the change, not the sum: base-usd
// plus max($10, 20 %) a month. base-usd is what BASE_PLAN_JSON leads to — the preview
// of the base branch's program, which is what CI passes, because its stack is created
// fresh in every run and the oldState of PLAN_JSON is always empty there. Without
// BASE_PLAN_JSON it is the oldState of PLAN_JSON: a stack that already holds the base.
// gate=fail exits 1, unless the PR carries the bypass label (COST_BYPASS_LABEL, set by
// CI from the PR's labels) — then the verdict is still printed as fail, with the label
// next to it, and the exit is 0.

import { readFileSync } from 'node:fs';

import { planCost, type Plan } from './mapping';

const DELTA_USD = 10;
const DELTA_SHARE = 0.2;

const planPath = process.env.PLAN_JSON;
if (!planPath) {
  console.error('gate:cost: PLAN_JSON is not set — the output of `pulumi preview --json`');
  process.exit(2);
}

function readPlan(path: string): Plan {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Plan;
  } catch (err) {
    console.error(`gate:cost: cannot read ${path}: ${(err as Error).message}`);
    process.exit(2);
  }
}

const basePlanPath = process.env.BASE_PLAN_JSON || undefined;
const { planUsd, baseUsd: oldStateUsd, lines } = planCost(readPlan(planPath));
const baseUsd = basePlanPath ? planCost(readPlan(basePlanPath)).planUsd : oldStateUsd;
const explicit = process.env.COST_BUDGET_USD;
if (explicit !== undefined && explicit !== '' && !Number.isFinite(Number(explicit))) {
  console.error(`gate:cost: COST_BUDGET_USD must be a number, got "${explicit}"`);
  process.exit(2);
}
const budgetUsd =
  explicit !== undefined && explicit !== '' ? Number(explicit) : baseUsd + Math.max(DELTA_USD, baseUsd * DELTA_SHARE);
const pass = planUsd <= budgetUsd;
const bypass = process.env.COST_BYPASS_LABEL ?? '';

const usd = (n: number) => n.toFixed(2);
for (const l of lines.filter((x) => x.usd > 0)) console.log(`# ${usd(l.usd)} USD/month  ${l.type}  ${l.urn.split('::').pop()}`);
console.log(`plan-file=${planPath}`);
console.log(`resources=${lines.length}`);
console.log(`base-source=${basePlanPath ? `base-plan ${basePlanPath}` : 'oldState of the plan'}`);
console.log(`base-usd=${usd(baseUsd)}`);
console.log(`plan-usd=${usd(planUsd)}`);
console.log(`delta-usd=${usd(planUsd - baseUsd)}`);
console.log(`budget-usd=${usd(budgetUsd)}`);
console.log(`budget-source=${explicit ? 'COST_BUDGET_USD' : `base + max(${DELTA_USD}, ${DELTA_SHARE * 100}%)`}`);
console.log(`gate=${pass ? 'pass' : 'fail'}`);
if (!pass && bypass) console.log(`bypass=${bypass}`);
process.exit(pass || bypass ? 0 : 1);
