"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const mapping_1 = require("./mapping");
const DELTA_USD = 10;
const DELTA_SHARE = 0.2;
const planPath = process.env.PLAN_JSON;
if (!planPath) {
    console.error('gate:cost: PLAN_JSON is not set — the output of `pulumi preview --json`');
    process.exit(2);
}
function readPlan(path) {
    try {
        return JSON.parse((0, node_fs_1.readFileSync)(path, 'utf8'));
    }
    catch (err) {
        console.error(`gate:cost: cannot read ${path}: ${err.message}`);
        process.exit(2);
    }
}
const basePlanPath = process.env.BASE_PLAN_JSON || undefined;
const { planUsd, baseUsd: oldStateUsd, lines } = (0, mapping_1.planCost)(readPlan(planPath));
const baseUsd = basePlanPath ? (0, mapping_1.planCost)(readPlan(basePlanPath)).planUsd : oldStateUsd;
const explicit = process.env.COST_BUDGET_USD;
if (explicit !== undefined && explicit !== '' && !Number.isFinite(Number(explicit))) {
    console.error(`gate:cost: COST_BUDGET_USD must be a number, got "${explicit}"`);
    process.exit(2);
}
const budgetUsd = explicit !== undefined && explicit !== '' ? Number(explicit) : baseUsd + Math.max(DELTA_USD, baseUsd * DELTA_SHARE);
const pass = planUsd <= budgetUsd;
const bypass = process.env.COST_BYPASS_LABEL ?? '';
const usd = (n) => n.toFixed(2);
for (const l of lines.filter((x) => x.usd > 0))
    console.log(`# ${usd(l.usd)} USD/month  ${l.type}  ${l.urn.split('::').pop()}`);
console.log(`plan-file=${planPath}`);
console.log(`resources=${lines.length}`);
console.log(`base-source=${basePlanPath ? `base-plan ${basePlanPath}` : 'oldState of the plan'}`);
console.log(`base-usd=${usd(baseUsd)}`);
console.log(`plan-usd=${usd(planUsd)}`);
console.log(`delta-usd=${usd(planUsd - baseUsd)}`);
console.log(`budget-usd=${usd(budgetUsd)}`);
console.log(`budget-source=${explicit ? 'COST_BUDGET_USD' : `base + max(${DELTA_USD}, ${DELTA_SHARE * 100}%)`}`);
console.log(`gate=${pass ? 'pass' : 'fail'}`);
if (!pass && bypass)
    console.log(`bypass=${bypass}`);
process.exit(pass || bypass ? 0 : 1);
