import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { fixture, request } from './harness.mjs';
import { createAuth, createDiscordProvider, SESSION_COOKIE } from '../auth.mjs';
import { createHandler, MAX_BODY_BYTES } from '../http.mjs';
import { createService } from '../service.mjs';
import { createJobRunner } from '../jobs.mjs';
import { loadConfig } from '../config.mjs';

test('independent: malformed or absent service configuration is fail-closed without touching a database', async () => {
  const base = { APP_ORIGIN: 'https://pvme.example', DATABASE_URL: 'postgres://user:pass@db.example/database', SESSION_SECRET: 'a'.repeat(40), DISCORD_CLIENT_ID: '123456', DISCORD_CLIENT_SECRET: 'test-only', PVME_CONTRIBUTOR_DISCORD_IDS: '123456' };
  const invalid = [
    {}, { ...base, APP_ORIGIN: 'https://pvme.example/redirect' },
    { ...base, APP_ORIGIN: 'https://user:pass@pvme.example' },
    { ...base, DATABASE_URL: 'postgres://user:%nothex@db.example/database' },
    { ...base, PVME_CONTRIBUTOR_DISCORD_IDS: '' },
    { ...base, PVME_ACCESS_MODE: 'unexpected' },
    { ...base, GITHUB_OWNER: 'partial-configuration' },
  ];
  for (const env of invalid) {
    const config = loadConfig(env);
    assert.equal(config.configured, false);
    const handler = createHandler({ config, db: { query() { throw Error('Database must not be touched'); } } });
    const session = await handler(request('session'));
    assert.equal(session.status, 200);
    const data = await session.json();
    assert.equal(data.configured, false);
    assert.equal(data.user, null);
    assert.ok(Object.values(data.capabilities).every(value => value === false));
    assert.equal((await handler(request('drafts'))).status, 503);
  }
});

test('independent: sessions expire, respect account disabling and invite revocation, and reject duplicate auth cookies', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const user = await f.user('contributor', '123456');
  const config = { ...f.config, accessMode: 'allowlist', allowedDiscordIds: ['123456'] };
  const auth = createAuth(f.db, config);
  assert.equal((await auth.session(user.cookie)).user.id, user.id);
  assert.equal(await auth.session(`${SESSION_COOKIE}=invalid`), null);
  await assert.rejects(auth.session(`${user.cookie}; ${user.cookie}`), error => error.code === 'invalid_cookie');
  config.allowedDiscordIds = ['654321'];
  assert.equal(await auth.session(user.cookie), null);
  config.allowedDiscordIds = ['123456'];
  await f.db.query('UPDATE users SET disabled=true WHERE id=$1', [user.id]);
  assert.equal(await auth.session(user.cookie), null);
  await f.db.query('UPDATE users SET disabled=false WHERE id=$1', [user.id]);
  await f.db.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1", [user.id]);
  assert.equal(await auth.session(user.cookie), null);
});

test('independent: logout and role changes invalidate old sessions rather than trusting cached roles', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const admin = await f.user('admin'), moderator = await f.user('moderator'), contributor = await f.user();
  const service = createService(f.db), handler = createHandler({ db: f.db, config: f.config });
  assert.equal((await handler(request('session', { user: moderator }))).status, 200);
  await assert.rejects(service.changeRole(contributor.id, moderator.id, { expectedVersion: 1, role: 'admin' }), error => error.status === 403);
  await assert.rejects(service.changeRole(admin.id, admin.id, { expectedVersion: 1, role: 'contributor' }), error => error.code === 'self_role_change');
  await service.changeRole(admin.id, moderator.id, { expectedVersion: 1, role: 'contributor' });
  assert.equal((await handler(request('drafts', { user: moderator }))).status, 401);
  assert.equal((await (await handler(request('session', { user: moderator }))).json()).user, null);
  const logout = await handler(request('logout', { user: contributor, method: 'POST', body: {} }));
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await handler(request('drafts', { user: contributor }))).status, 401);
  assert.equal((await handler(request('logout', { user: contributor, method: 'POST', body: {} }))).status, 401);
});

test('independent: Discord requests only identity scope and revokes ephemeral tokens without persisting them', async () => {
  const calls = [], token = 'unit-test-ephemeral-access-token';
  const provider = createDiscordProvider({ clientId: '123456', clientSecret: 'unit-test-client-secret', redirectUri: 'https://pvme.example/api/editor/auth/discord/callback' }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      if (url.endsWith('/token')) return Response.json({ access_token: token, token_type: 'Bearer', scope: 'identify' });
      if (url.endsWith('/users/@me')) return Response.json({ id: '123456', username: 'Username', global_name: 'Display name', email: 'must-not-escape@example.test' });
      if (url.endsWith('/revoke')) return new Response(null, { status: 204 });
      throw Error('Unexpected provider URL');
    },
  });
  const authorize = new URL(provider.authorize('state-token'));
  assert.equal(authorize.searchParams.get('scope'), 'identify');
  assert.equal(authorize.searchParams.get('response_type'), 'code');
  const identity = await provider.identity('unit-test-code');
  assert.deepEqual(identity, { discordId: '123456', displayName: 'Display name' });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[2].init.body.get('token'), token);
  assert.doesNotMatch(JSON.stringify(identity), /email|access_token|unit-test|secret/);
});

test('independent: API errors hide operational secrets and private responses are never cacheable', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const user = await f.user();
  const healthy = createHandler({ db: f.db, config: f.config });
  const session = await healthy(request('session', { user }));
  assert.match(session.headers.get('cache-control'), /private.*no-store/);
  assert.equal(session.headers.get('x-frame-options'), 'DENY');
  const wrongHost = new Request('https://attacker.example/api/editor/session', { headers: { cookie: user.cookie } });
  assert.equal((await healthy(wrongHost)).status, 403);
  const broken = createHandler({ db: { query: async () => { throw Error('postgres://secret-user:secret-pass@private-db/internal.sql'); } }, config: f.config });
  const response = await broken(request('drafts', { user }));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /secret-user|secret-pass|private-db|internal.sql/);
  const large = await healthy(request(`drafts/${f.guide.id}`, { user, method: 'PUT', body: '{}', headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } }));
  assert.equal(large.status, 413);
});

test('independent: webhook signatures, private repository and installation must all match before a delivery is recorded', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const handler = createHandler({ db: f.db, config: f.config, publisher: {} });
  const payload = { repository: { full_name: 'example/private-guides', private: true }, installation: { id: f.config.github.installationId } };
  const send = async (data, signature = null, delivery = randomUUID()) => {
    const raw = JSON.stringify(data);
    const actual = signature ?? `sha256=${createHmac('sha256', f.config.github.webhookSecret).update(raw).digest('hex')}`;
    return handler(request('webhooks/github', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': actual, 'x-github-delivery': delivery, 'x-github-event': 'push' } }));
  };
  assert.equal((await send(payload, 'sha256=bad')).status, 401);
  assert.equal((await send({ ...payload, repository: { ...payload.repository, private: false } })).status, 403);
  assert.equal((await send({ ...payload, installation: { id: 'unrelated' } })).status, 403);
  assert.equal((await f.db.query('SELECT count(*) FROM webhook_deliveries')).rows[0].count, 0);
  const id = randomUUID();
  assert.equal((await send(payload, null, id)).status, 200);
  assert.equal((await (await send(payload, null, id)).json()).duplicate, true);
  assert.equal((await f.db.query('SELECT count(*) FROM webhook_deliveries')).rows[0].count, 1);
  assert.equal((await f.db.query('SELECT count(*) FROM publication_jobs')).rows[0].count, 0);
  assert.equal((await handler(request('jobs/publication', { headers: { Authorization: 'Bearer incorrect' } }))).status, 401);
});

test('independent: late completion from an expired publication lease cannot overwrite a newer worker', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const owner = await f.user(), reviewer = await f.user('moderator');
  const service = createService(f.db, { publicationEnabled: true });
  await service.saveDraft(owner.id, f.guide.id, { expectedVersion: 0, baseRevision: 1, document: f.changed('Approved snapshot') });
  const submission = await service.submit(owner.id, f.guide.id, { expectedVersion: 1, summary: 'Lease fencing test' });
  await service.review(reviewer.id, submission.id, { expectedVersion: 1, decision: 'approve', note: '' });
  let started, release;
  const began = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const oldProvider = {
    ensurePullRequest: async () => { started(); await blocked; return { number: 1, branch: 'pvme/test-fixture', branchSha: 'b'.repeat(40) }; },
    reconcile: async () => ({ state: 'published', provider: { number: 1, branch: 'pvme/test-fixture', branchSha: 'b'.repeat(40), merged: true, mergeSha: 'a'.repeat(40), deployedCommit: 'a'.repeat(40) } }),
  };
  const newerProvider = {
    ensurePullRequest: async () => ({ number: 1, branch: 'pvme/test-fixture', branchSha: 'b'.repeat(40) }),
    reconcile: async () => ({ state: 'awaiting_merge', provider: { number: 1, branch: 'pvme/test-fixture', branchSha: 'b'.repeat(40), merged: false } }),
  };
  const old = createJobRunner(f.db, oldProvider, { origin: f.config.origin }).runOne();
  await began;
  try {
    assert.equal((await createJobRunner(f.db, newerProvider).runOne()).state, 'idle');
    await f.db.query("UPDATE publication_jobs SET lease_until=now()-interval '1 second' WHERE submission_id=$1", [submission.id]);
    assert.equal((await createJobRunner(f.db, newerProvider).runOne()).state, 'awaiting_merge');
  } finally { release(); }
  assert.equal((await old).state, 'superseded');
  assert.equal((await service.getGuide(f.guide.id)).revision, 1);
  const job = (await f.db.query('SELECT state,provider FROM publication_jobs WHERE submission_id=$1', [submission.id])).rows[0];
  assert.equal(job.state, 'awaiting_merge');
  assert.equal(job.provider.merged, false);
});
