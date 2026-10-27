import 'reflect-metadata';

import { Invariants, pause, report, runDemo } from './common/demo-output';
import { connectRedis } from './redis/connection';
import { Pod } from './redis/pod-process';
import { sessionKey } from './sessions/session-store';
import { SESSION_COOKIE } from './sessions/session.middleware';

// A session in Redis with a rolling TTL, across a killed process.
//
//   request 1  no cookie → pod A creates the session, Set-Cookie: sid=…
//   wait 2 s   the TTL in Redis runs down
//   request 2  with the cookie → the same session, TTL pushed back up
//   kill -9 A, start pod B
//   request 3  with the same cookie → pod B finds the same session in Redis
//   request 4  once more, to see the counter keep going
//
// `sessions` is the number of distinct ids the server handed out over all of it.

const TTL_SECONDS = 60;
const IDLE_MS = 2000;

interface Reply {
  status: number;
  sid: string | undefined;
  pid: number;
  hits: number;
}

async function request(pod: Pod, sid: string | undefined): Promise<Reply> {
  const response = await fetch(`${pod.url}/session`, {
    headers: sid === undefined ? {} : { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sid)}` },
  });
  const body = (await response.json()) as { pid: number; hits: number };
  const issued = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
  return {
    status: response.status,
    sid: issued === undefined ? undefined : decodeURIComponent(issued.slice(SESSION_COOKIE.length + 1)),
    pid: body.pid,
    hits: body.hits,
  };
}

runDemo(async () => {
  const invariants = new Invariants();
  const redis = connectRedis('queue', 'demo-session');
  const issued = new Set<string>();
  const pods: Pod[] = [];

  try {
    const podA = await Pod.start(['--session-ttl', String(TTL_SECONDS)]);
    pods.push(podA);

    const first = await request(podA, undefined);
    if (first.sid === undefined) throw new Error('the first response set no session cookie');
    issued.add(first.sid);
    const sid = first.sid;
    console.log(`1. pod A (pid ${first.pid}): new session ${sid.slice(0, 8)}…, hits ${first.hits}`);

    await pause(IDLE_MS);
    const ttlBefore = await redis.pttl(sessionKey(sid));
    const second = await request(podA, sid);
    const ttlAfter = await redis.pttl(sessionKey(sid));
    if (second.sid !== undefined) issued.add(second.sid);
    console.log(
      `2. after ${IDLE_MS / 1000} s idle: TTL ${ttlBefore} ms → request → ${ttlAfter} ms, hits ${second.hits}`,
    );

    await podA.crash();
    const podB = await Pod.start(['--session-ttl', String(TTL_SECONDS)]);
    pods.push(podB);
    console.log(`   pod A killed with SIGKILL, pod B started (pid ${podB.pid})`);

    const third = await request(podB, sid);
    if (third.sid !== undefined) issued.add(third.sid);
    const fourth = await request(podB, sid);
    if (fourth.sid !== undefined) issued.add(fourth.sid);
    console.log(`3. pod B (pid ${third.pid}): same cookie → hits ${third.hits}, then ${fourth.hits}`);

    const inRedis = (await redis.exists(sessionKey(sid))) === 1;
    const ttlFinal = await redis.ttl(sessionKey(sid));
    console.log(`   ${sessionKey(sid).slice(0, 13)}… in Redis: ${inRedis}, TTL ${ttlFinal} s of ${TTL_SECONDS}\n`);

    const requests = 4;
    invariants.check('one session over every request', issued.size === 1, `${issued.size} ids`);
    invariants.check('session key is in Redis', inRedis, `${inRedis}`);
    invariants.check('activity renews the TTL', ttlAfter > ttlBefore, `${ttlBefore} → ${ttlAfter} ms`);
    invariants.check('the session survived a killed process', third.pid !== first.pid && third.hits === 3, `hits ${third.hits} on pid ${third.pid}`);
    invariants.check('every request counted', fourth.hits === requests, `hits ${fourth.hits}`);
    console.log('');

    report({
      requests,
      sessions: issued.size,
      'in-redis': inRedis ? 1 : 0,
      'ttl-before-ms': ttlBefore,
      'ttl-after-ms': ttlAfter,
      'ttl-renewed': ttlAfter > ttlBefore ? 1 : 0,
      'survived-restart': third.pid !== first.pid && third.hits === 3 ? 1 : 0,
      hits: fourth.hits,
    });

    return invariants.broken === 0 ? 0 : 1;
  } finally {
    for (const sid of issued) await redis.del(sessionKey(sid));
    for (const pod of pods) await pod.stop();
    await redis.quit();
  }
});
