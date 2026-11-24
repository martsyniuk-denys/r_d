"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RATES = void 0;
exports.cpuCores = cpuCores;
exports.gibibytes = gibibytes;
exports.monthlyUsd = monthlyUsd;
exports.planCost = planCost;
exports.RATES = {
    vcpuHourUsd: 0.04048,
    gbHourUsd: 0.004445,
    loadBalancerHourUsd: 0.0225,
    volumeGbMonthUsd: 0.08,
    hoursPerMonth: 730,
};
const GONE = new Set(['delete', 'delete-replaced', 'discard', 'discard-replaced', 'remove-pending-replace']);
function cpuCores(quantity) {
    const q = String(quantity ?? '0');
    return q.endsWith('m') ? Number(q.slice(0, -1)) / 1000 : Number(q);
}
const MEMORY_UNITS = {
    Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
    k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12,
};
function gibibytes(quantity) {
    const m = /^([0-9.]+)([A-Za-z]*)$/.exec(String(quantity ?? '0'));
    if (!m)
        return 0;
    const bytes = Number(m[1]) * (m[2] ? MEMORY_UNITS[m[2]] ?? NaN : 1);
    return bytes / 2 ** 30;
}
function podMonthlyUsd(podSpec) {
    let cores = 0;
    let gib = 0;
    for (const c of (podSpec?.containers ?? [])) {
        cores += cpuCores(c.resources?.requests?.cpu);
        gib += gibibytes(c.resources?.requests?.memory);
    }
    return (cores * exports.RATES.vcpuHourUsd + gib * exports.RATES.gbHourUsd) * exports.RATES.hoursPerMonth;
}
function monthlyUsd(type, inputs = {}) {
    switch (type) {
        case 'kubernetes:apps/v1:Deployment':
            return (inputs.spec?.replicas ?? 1) * podMonthlyUsd(inputs.spec?.template?.spec);
        case 'kubernetes:apps/v1:StatefulSet': {
            const replicas = inputs.spec?.replicas ?? 1;
            const volumesGib = (inputs.spec?.volumeClaimTemplates ?? [])
                .map((t) => gibibytes(t.spec?.resources?.requests?.storage))
                .reduce((a, b) => a + b, 0);
            return replicas * (podMonthlyUsd(inputs.spec?.template?.spec) + volumesGib * exports.RATES.volumeGbMonthUsd);
        }
        case 'kubernetes:core/v1:Service':
            return inputs.spec?.type === 'LoadBalancer' ? exports.RATES.loadBalancerHourUsd * exports.RATES.hoursPerMonth : 0;
        case 'kubernetes:core/v1:PersistentVolumeClaim':
            return gibibytes(inputs.spec?.resources?.requests?.storage) * exports.RATES.volumeGbMonthUsd;
        default:
            return 0;
    }
}
function planCost(plan) {
    const after = new Map();
    const before = new Map();
    for (const step of plan.steps ?? []) {
        if (step.oldState)
            before.set(step.urn, monthlyUsd(step.oldState.type, step.oldState.inputs));
        if (step.newState && !GONE.has(step.op)) {
            after.set(step.urn, { urn: step.urn, type: step.newState.type, usd: monthlyUsd(step.newState.type, step.newState.inputs) });
        }
        if (GONE.has(step.op))
            after.delete(step.urn);
    }
    const lines = [...after.values()];
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    return { planUsd: sum(lines.map((l) => l.usd)), baseUsd: sum([...before.values()]), lines };
}
