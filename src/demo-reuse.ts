import 'reflect-metadata';

import { Api, Invariants, claimsOf, login, openDatabase, refresh, report, resetAccount, runDemo } from './auth/demo-kit';

// A stolen token has a finite life, proof (b): reuse of a refresh token kills the
// whole family.
//
//   login                          → R1
//   the client refreshes with R1   → 200, R2 (R1 is now used)
//   R1 is presented again          → 401: a used token came back. Either the client
//                                    or a thief holds a copy, and the server cannot
//                                    tell which — so it revokes the family
//   the client refreshes with R2   → 401: the honest client is out too
//
// Rotation without the family would answer 401 to the replay and 200 to R2 — and
// if the thief had refreshed first, the thief's session would be the one alive.

runDemo(async () => {
  const invariants = new Invariants();
  const dataSource = await openDatabase();
  let api: Api | undefined;

  try {
    const buyer = await resetAccount(dataSource, 'demo-reuse', 'buyer', 'buyer');
    api = await Api.start();

    const first = await login(api, buyer);
    const r1 = first.body.refresh_token;
    const familyId = claimsOf(first.body.access_token).sid as string;

    const rotated = await refresh(api, r1);
    const reuse = await refresh(api, r1);
    const afterReuse = await refresh(api, rotated.body.refresh_token);

    const [family]: { total: number; live: number; used: number }[] = await dataSource.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE revoked_at IS NULL)::int AS live,
              count(*) FILTER (WHERE used_at IS NOT NULL)::int AS used
         FROM refresh_tokens WHERE family_id = $1`,
      [familyId],
    );
    const [chain]: { linked: number }[] = await dataSource.query(
      `SELECT count(*)::int AS linked FROM refresh_tokens c JOIN refresh_tokens p ON p.id = c.parent_id
        WHERE c.family_id = $1 AND p.family_id = $1`,
      [familyId],
    );
    const logged = api.log.filter((line) => line.includes('refresh token reuse detected') && line.includes(familyId));

    console.log(`family ${familyId}: ${family.total} tokens, ${family.used} used, ${family.live} live, ${chain.linked} parent link(s)`);
    for (const line of logged) console.log(`api log: ${line.replace(/^.*?\[auth\]\s*/, '[auth] ')}`);
    console.log('');

    invariants.check('login', first.status === 200, `${first.status}`);
    invariants.check('the first refresh rotates', rotated.status === 200, `${rotated.status}`);
    invariants.check('the replayed refresh token is refused', reuse.status === 401, `${reuse.status}`);
    invariants.check('the newest token of the family is dead too', afterReuse.status === 401, `${afterReuse.status}`);
    invariants.check('every token of the family is revoked', family.live === 0 && family.total === 2, `${family.live} live of ${family.total}`);
    invariants.check('old → new link is kept', chain.linked === 1, `${chain.linked}`);
    invariants.check('the reuse is logged once, with the family id', logged.length === 1, `${logged.length} line(s)`);
    console.log('');

    report({
      login: first.status,
      'r1-refresh': rotated.status,
      'r1-reuse': reuse.status,
      'r2-after-reuse': afterReuse.status,
      'family-tokens': family.total,
      'family-live': family.live,
      'reuse-logged': logged.length,
    });

    if (invariants.broken > 0) console.error(api.log.join('\n'));
    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await api?.stop();
    await dataSource.destroy();
  }
});
