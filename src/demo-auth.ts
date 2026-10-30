import 'reflect-metadata';

import { Api, Invariants, claimsOf, login, openDatabase, refresh, report, resetAccount, runDemo } from './auth/demo-kit';

// A stolen token has a finite life, proof (a): logout kills both halves.
//
//   login                     → pair 1
//   GET /auth/me, no token    → 401
//   GET /auth/me, access 1    → 200
//   refresh with refresh 1    → pair 2 (refresh 1 is now used)
//   logout with access 2      → 204: family revoked + jti of access 2 denylisted, one COMMIT
//   GET /auth/me, access 2    → 401 — still before its exp, so only the denylist can say no
//   refresh with refresh 2    → 401 — the family is revoked
//
// Not the same mechanism twice: refresh 2 is a row the server marks; access 2 is
// self-contained and would verify until exp without the denylist.

runDemo(async () => {
  const invariants = new Invariants();
  const dataSource = await openDatabase();
  let api: Api | undefined;

  try {
    const buyer = await resetAccount(dataSource, 'demo-auth', 'buyer', 'buyer');
    api = await Api.start();

    const first = await login(api, buyer);
    const noToken = await api.call('GET', '/auth/me');
    const withToken = await api.call('GET', '/auth/me', { token: first.body.access_token });
    const second = await refresh(api, first.body.refresh_token);
    const access = second.body.access_token;
    const logout = await api.call('POST', '/auth/logout', { token: access });
    const afterLogout = await api.call('GET', '/auth/me', { token: access });
    const refreshAfterLogout = await refresh(api, second.body.refresh_token);

    const { jti, sid, exp } = claimsOf(access) as { jti: string; sid: string; exp: number };
    const [denied]: { ttl: number }[] = await dataSource.query(
      `SELECT (extract(epoch FROM expires_at)::bigint - $2::bigint)::int AS ttl FROM revoked_access_tokens WHERE jti = $1`,
      [jti, exp],
    );
    const [family]: { total: number; live: number }[] = await dataSource.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE revoked_at IS NULL)::int AS live
         FROM refresh_tokens WHERE family_id = $1`,
      [sid],
    );
    const stillValid = exp > Math.floor(Date.now() / 1000);

    console.log(`access 2: jti=${jti} family=${sid}, exp in ${exp - Math.floor(Date.now() / 1000)} s`);
    console.log(`family ${sid}: ${family.total} refresh tokens, ${family.live} live`);
    console.log(`denylist row: ${denied === undefined ? 'missing' : `expires at the token's exp (${denied.ttl >= 0 ? '+' : ''}${denied.ttl} s)`}\n`);

    invariants.check('login', first.status === 200, `${first.status}`);
    invariants.check('no token is 401', noToken.status === 401, `${noToken.status}`);
    invariants.check('a valid token is 200', withToken.status === 200, `${withToken.status}`);
    invariants.check('refresh rotates', second.status === 200 && second.body.refresh_token !== first.body.refresh_token, `${second.status}`);
    invariants.check('logout', logout.status === 204 || logout.status === 200, `${logout.status}`);
    invariants.check('access after logout is 401 while still unexpired', afterLogout.status === 401 && stillValid, `${afterLogout.status}, unexpired=${stillValid}`);
    invariants.check('refresh after logout is 401', refreshAfterLogout.status === 401, `${refreshAfterLogout.status}`);
    invariants.check('denylist TTL = remaining life of the token', denied !== undefined && denied.ttl === 0, denied === undefined ? 'no row' : `${denied.ttl} s off`);
    invariants.check('no live refresh token left in the family', family.live === 0, `${family.live} live of ${family.total}`);
    console.log('');

    report({
      login: first.status,
      'no-token': noToken.status,
      'with-token': withToken.status,
      refresh: second.status,
      logout: logout.status,
      'after-logout': afterLogout.status,
      'refresh-after-logout': refreshAfterLogout.status,
      'family-live': family.live,
      denylisted: denied === undefined ? 0 : 1,
    });

    if (invariants.broken > 0) console.error(api.log.join('\n'));
    return invariants.broken === 0 ? 0 : 1;
  } finally {
    await api?.stop();
    await dataSource.destroy();
  }
});
