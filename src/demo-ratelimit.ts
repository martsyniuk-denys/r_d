import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { Invariants, report, runDemo } from './common/demo-output';
import { connectRedis } from './redis/connection';
import { Pod } from './redis/pod-process';

// One rate limit shared by two pods.
//
// Two dist/pod.js processes, each with its own limiter object and nothing shared
// in memory, both limiting the same client to LIMIT requests per window. The
// client sends BURST requests at once, alternating between the pods. With the
// window in Redis the pods admit LIMIT between them; with a counter in process
// memory each would admit LIMIT, 2 × LIMIT in total, and nobody would see a 429.

const PODS = 2;
const LIMIT = 5;
const WINDOW_MS = 10_000;
const BURST = 20;

interface Reply {
  pod: number;
  status: number;
  retryAfter: string | null;
}

runDemo(async () => {
  const invariants = new Invariants();
  const redis = connectRedis('queue', 'demo-ratelimit');
  const prefix = 'rl-demo';
  const client = `demo-${randomUUID()}`;
  const args = ['--limit', String(LIMIT), '--window-ms', String(WINDOW_MS), '--rate-prefix', prefix];
  const pods = await Promise.all(Array.from({ length: PODS }, () => Pod.start(args)));

  try {
    console.log(`pods: ${pods.map((pod) => `pid ${pod.pid}`).join(', ')}; limit ${LIMIT} per ${WINDOW_MS / 1000} s per client\n`);

    const replies = await Promise.all(
      Array.from({ length: BURST }, async (_, i): Promise<Reply> => {
        const pod = i % PODS;
        const response = await fetch(`${pods[pod].url}/limited`, { headers: { 'x-client-id': client } });
        await response.arrayBuffer();
        return { pod, status: response.status, retryAfter: response.headers.get('retry-after') };
      }),
    );

    const allowed = replies.filter((r) => r.status === 200);
    const blocked = replies.filter((r) => r.status === 429);
    const lastBlocked = blocked.at(-1);
    for (let pod = 0; pod < PODS; pod += 1) {
      const mine = replies.filter((r) => r.pod === pod);
      console.log(
        `  pod ${pod} (pid ${pods[pod].pid}): ${mine.filter((r) => r.status === 200).length} allowed, ` +
          `${mine.filter((r) => r.status === 429).length} blocked`,
      );
    }
    console.log(`  last rejection: ${lastBlocked?.status} Retry-After: ${lastBlocked?.retryAfter} s\n`);

    const retryAfterSet = lastBlocked !== undefined && lastBlocked.retryAfter !== null && Number(lastBlocked.retryAfter) >= 1;
    const instances = new Set(pods.map((pod) => pod.pid)).size;
    const bothPodsAdmitted = new Set(allowed.map((r) => r.pod)).size;

    invariants.check('independent pods', instances === PODS, `${instances} pids`);
    invariants.check('the limit is shared', allowed.length === LIMIT, `${allowed.length} allowed for limit ${LIMIT}`);
    invariants.check('the rest is rejected', blocked.length === BURST - LIMIT, `${blocked.length} blocked`);
    invariants.check('rejection is 429 with Retry-After', lastBlocked?.status === 429 && retryAfterSet, `${lastBlocked?.status}`);
    console.log('');

    report({
      instances,
      limit: LIMIT,
      requests: BURST,
      allowed: allowed.length,
      blocked: blocked.length,
      status: lastBlocked?.status ?? 200,
      'retry-after': retryAfterSet ? 1 : 0,
      'pods-that-admitted': bothPodsAdmitted,
    });

    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await redis.del(`${prefix}:${client}`);
    for (const pod of pods) await pod.stop();
    await redis.quit();
  }
});
