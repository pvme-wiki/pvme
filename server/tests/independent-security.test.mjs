import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { fixture, request } from './harness.mjs';
import { createAuth, STATE_COOKIE } from '../auth.mjs';
import { createHandler } from '../http.mjs';
import { createService } from '../service.mjs';
import { createJobRunner } from '../jobs.mjs';
import { loadConfig } from '../config.mjs';
import { postgresOptions } from '../db.mjs';
import { documentHash } from '../core.mjs';

// Independent regression coverage. Providers below are in-process fakes only;
// the database, SQL transactions, constraints and triggers are real PGlite.
const validEnvironment = {
  APP_ORIGIN: 'https://pvme.example', DATABASE_URL: 'postgres://user:pass@db.example/database',
  SESSION_SECRET: 'a'.repeat(40), DISCORD_CLIENT_ID: '123456',
  DISCORD_CLIENT_SECRET: 'test-only', PVME_CONTRIBUTOR_DISCORD_IDS: '123456',
};

test('independent: PostgreSQL URL aliases cannot disable certificate verification', () => {
  for (const query of ['ssl=0', 'ssl=no-verify', 'sslmode=disable', 'sslmode=verify-full&ssl=0']) {
    const databaseUrl = `${validEnvironment.DATABASE_URL}?${query}`;
    assert.equal(loadConfig({ ...validEnvironment, DATABASE_URL: databaseUrl }).configured, false, query);
    const client = new pg.Client(postgresOptions(databaseUrl));
    assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: true }, query);
  }
  const options = postgresOptions(`${validEnvironment.DATABASE_URL}?host=attacker.example&user=other&password=bad&options=-c%20statement_timeout%3D0`);
  const client = new pg.Client(options);
  assert.equal(client.connectionParameters.host, 'db.example');
  assert.equal(client.connectionParameters.user, 'user');
  assert.equal(client.connectionParameters.statement_timeout, 12000);
});

test('independent: unknown users cannot enter the private pilot and OAuth states are one-use', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  let identityCalls = 0;
  const provider = {
    authorize: state => `https://discord.com/oauth2/authorize?state=${state}`,
    identity: async () => { identityCalls++; return { discordId: '777777', displayName: 'Uninvited person' }; },
  };
  const auth = createAuth(f.db, { ...f.config, accessMode: 'allowlist', allowedDiscordIds: ['123456'] }, { provider });
  const started = await auth.start();
  const state = new URL(started.location).searchParams.get('state');
  const binding = started.cookie.split(';')[0];
  const params = new URLSearchParams({ state, code: 'test-code' });
  await assert.rejects(auth.callback(params, binding), error => error.status === 403 && error.code === 'pilot_access_required');
  assert.equal((await f.db.query('SELECT count(*) FROM users')).rows[0].count, 0);
  assert.equal((await f.db.query('SELECT count(*) FROM sessions')).rows[0].count, 0);
  await assert.rejects(auth.callback(params, binding), error => error.code === 'invalid_oauth_state');
  assert.equal(identityCalls, 1);
});

test('independent: OAuth requires browser binding and returns only to the deployed hosted path', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const provider = { authorize: state => `https://discord.com/oauth2/authorize?state=${state}`, identity: async () => ({ discordId: '123456', displayName: 'Invited person' }) };
  const auth = createAuth(f.db, f.config, { provider });
  const started = await auth.start();
  const params = new URLSearchParams({ state: new URL(started.location).searchParams.get('state'), code: 'test-code', returnTo: 'https://attacker.example' });
  await assert.rejects(auth.callback(params, `${STATE_COOKIE}=${'x'.repeat(43)}`), error => error.code === 'invalid_oauth_state');
  const result = await auth.callback(params, started.cookie.split(';')[0]);
  assert.equal(result.location, `${f.config.origin}/edit/`);
  assert.match(result.cookies[0], /Secure; HttpOnly; SameSite=Lax/);
  assert.doesNotMatch(result.cookies[0], /Domain=/);
  const handler = createHandler({ db: f.db, config: f.config, identityProvider: provider });
  const failed = await handler(request('auth/discord/callback?state=invalid&code=bad'));
  assert.equal(failed.status, 303);
  assert.equal(new URL(failed.headers.get('location')).pathname, '/edit/');
});

test('independent: cross-user draft and submission access is denied, including forged role fields', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const owner = await f.user(), stranger = await f.user(), reviewer = await f.user('moderator');
  const handler = createHandler({ db: f.db, config: f.config });
  const service = createService(f.db);
  const saved = await service.saveDraft(owner.id, f.guide.id, { expectedVersion: 0, baseRevision: 1, document: f.changed() });
  const submitted = await service.submit(owner.id, f.guide.id, { expectedVersion: saved.version, summary: 'Private contribution' });
  assert.equal((await handler(request(`submissions/${submitted.id}`, { user: stranger }))).status, 404);
  const strangerDraft = await (await handler(request(`drafts/${f.guide.id}`, { user: stranger }))).json();
  assert.equal(strangerDraft.draft, null);
  const forged = await handler(request(`drafts/${f.guide.id}`, { user: stranger, method: 'PUT', body: { expectedVersion: 0, baseRevision: 1, document: f.changed(), ownerId: owner.id, role: 'admin' } }));
  assert.equal(forged.status, 400);
  assert.equal((await handler(request(`submissions/${submitted.id}/review`, { user: stranger, method: 'POST', body: { expectedVersion: 1, decision: 'approve', note: '' } }))).status, 403);
  assert.equal((await handler(request(`submissions/${submitted.id}`, { user: reviewer }))).status, 200);
  assert.equal((await service.getDraft(owner.id, f.guide.id)).version, 1);
});

test('independent: both same-origin and session-bound CSRF are required for mutations', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const user = await f.user(), other = await f.user();
  const handler = createHandler({ db: f.db, config: f.config });
  const body = { expectedVersion: 0, baseRevision: 1, document: f.changed() };
  for (const overrides of [
    { origin: 'https://attacker.example' },
    { headers: { Origin: '' } },
    { headers: { 'X-CSRF-Token': other.csrf } },
    { headers: { 'Sec-Fetch-Site': 'cross-site' } },
  ]) {
    const response = await handler(request(`drafts/${f.guide.id}`, { user, method: 'PUT', body, ...overrides }));
    assert.equal(response.status, 403);
  }
  assert.equal((await f.db.query('SELECT count(*) FROM drafts')).rows[0].count, 0);
  assert.equal((await handler(request(`drafts/${f.guide.id}`, { user, method: 'PUT', body }))).status, 200);
});

test('independent: stale saves cannot overwrite another browser and submitted snapshots remain immutable', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const owner = await f.user();
  const service = createService(f.db);
  const first = f.changed('First saved wording');
  await service.saveDraft(owner.id, f.guide.id, { expectedVersion: 0, baseRevision: 1, document: first });
  await assert.rejects(service.saveDraft(owner.id, f.guide.id, { expectedVersion: 0, baseRevision: 1, document: f.changed('Losing browser') }), error => error.code === 'revision_conflict');
  const submitted = await service.submit(owner.id, f.guide.id, { expectedVersion: 1, summary: 'First snapshot' });
  const again = await service.submit(owner.id, f.guide.id, { expectedVersion: 1, summary: 'Lost acknowledgement retry' });
  assert.equal(again.id, submitted.id);
  assert.equal(again.summary, 'First snapshot');
  await service.saveDraft(owner.id, f.guide.id, { expectedVersion: 1, baseRevision: 1, document: f.changed('Later private draft') });
  assert.equal((await service.getSubmission(owner.id, submitted.id)).document.title, first.title);
  await assert.rejects(f.db.query('UPDATE submissions SET document=$2 WHERE id=$1', [submitted.id, JSON.stringify(f.changed('Tampered'))]), /immutable/i);
  await assert.rejects(f.db.query('DELETE FROM submissions WHERE id=$1', [submitted.id]), /append-only/i);
  await assert.rejects(f.db.query('UPDATE draft_history SET document=$1', [JSON.stringify(f.changed('Tampered'))]), /append-only/i);
});

test('independent: a stale publication cannot roll the canonical guide backward', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const owner = await f.user(), reviewer = await f.user('moderator');
  const service = createService(f.db, { publicationEnabled: true });
  await service.saveDraft(owner.id, f.guide.id, { expectedVersion: 0, baseRevision: 1, document: f.changed('Old pending snapshot') });
  const submitted = await service.submit(owner.id, f.guide.id, { expectedVersion: 1, summary: 'Pending update' });
  await service.review(reviewer.id, submitted.id, { expectedVersion: 1, decision: 'approve', note: '' });
  const newer = f.changed('Newer canonical wording');
  await f.db.transaction(async q => {
    await q.query('INSERT INTO guide_revisions(guide_id,revision,document,content_hash) VALUES($1,2,$2,$3)', [f.guide.id, JSON.stringify(newer), documentHash(newer)]);
    await q.query('UPDATE guides SET revision=2 WHERE id=$1', [f.guide.id]);
  });
  const provider = {
    ensurePullRequest: async () => ({ number: 1, branch: 'pvme/test-fixture', branchSha: 'b'.repeat(40) }),
    reconcile: async () => ({ state: 'published', provider: { number: 1, branch: 'pvme/test-fixture', branchSha: 'b'.repeat(40), merged: true, mergeSha: 'a'.repeat(40), deployedCommit: 'a'.repeat(40) } }),
  };
  const outcome = await createJobRunner(f.db, provider, { origin: f.config.origin }).runOne();
  assert.equal(outcome.state, 'blocked');
  assert.equal(outcome.code, 'source_conflict');
  const current = await service.getGuide(f.guide.id);
  assert.equal(current.revision, 2);
  assert.equal(current.document.title, newer.title);
  assert.equal((await service.getSubmission(owner.id, submitted.id)).status, 'publishing');
});
