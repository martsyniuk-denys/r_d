// Small kubectl JSON readers for the demo scripts, so bash does not parse JSON.
//
//   kubectl get pods -l app=x -o json | node scripts/lib/pods.mjs settled <replicas> <rev>
//     → "yes" when exactly <replicas> pods exist (terminating ones included), all
//       ready and all on <rev>; otherwise "no total=… ready=… stale=…"
//   kubectl get pods -l app=x -o json | node scripts/lib/pods.mjs ready-names
//   kubectl get rs -l app=x -o json   | node scripts/lib/pods.mjs rs-created <rev>
//     → epoch seconds of the ReplicaSet whose template carries <rev>

import { readFileSync } from 'node:fs';

const [mode, ...args] = process.argv.slice(2);
const items = JSON.parse(readFileSync(0, 'utf8')).items ?? [];

const revOf = (template) =>
  template.spec.containers[0].env?.find((e) => e.name === 'REV')?.value;
const isReady = (pod) =>
  !pod.metadata.deletionTimestamp &&
  (pod.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');

if (mode === 'settled') {
  const [replicas, rev] = args;
  const total = items.length;
  const ready = items.filter(isReady).length;
  const stale = items.filter((p) => revOf(p) !== rev).length;
  const ok = total === Number(replicas) && ready === total && stale === 0;
  console.log(ok ? 'yes' : `no total=${total} ready=${ready} stale=${stale}`);
} else if (mode === 'ready-names') {
  for (const pod of items.filter(isReady)) console.log(pod.metadata.name);
} else if (mode === 'rs-created') {
  const rs = items.find((r) => revOf(r.spec.template) === args[0]);
  console.log(rs ? Math.floor(Date.parse(rs.metadata.creationTimestamp) / 1000) : '');
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
