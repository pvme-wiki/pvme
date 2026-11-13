import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './harness.mjs';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../manage.mjs';
import { createService } from '../service.mjs';
import { createJobRunner } from '../jobs.mjs';
import { approvedFiles } from '../github.mjs';
import { documentHash } from '../core.mjs';
import { validatePublicationTarget, trustedPublicationTarget, handoffGuidePublication } from '../publication-targets.mjs';
const legacy = { pipeline: 'legacy-v1', origin: 'legacy-v1', repository: { id: '101', owner: 'example', repo: 'private-guides', base: 'main' }, installationId: '12345' };
const content = { pipeline: 'content-pin-v1', origin: 'guides-v1', repository: { id: '202', owner: 'pvme-wiki', repo: 'guides', base: 'main' }, installationId: '67890' };
const registry = [legacy, { ...content, appRepository: legacy.repository }];
const options = { publicationEnabled: true, publicationTargets: registry, defaultPublicationTarget: legacy };
async function send(service, owner, guide, title, version = 0) {
  await service.saveDraft(owner.id, guide.id, { document: { ...structuredClone(guide), title }, expectedVersion: version, baseRevision: 1 });
  return service.submit(owner.id, guide.id, { expectedVersion: version + 1, summary: 'Review this exact snapshot' });
}
const handoff = (f, guide = f.guide) => handoffGuidePublication(f.db, { guideId: guide.id, target: content, expectedRevision: 1, expectedHash: documentHash(guide), contentCommit: 'a'.repeat(40), verifyContent: async () => true, reason: 'Verified staged operator handoff' });
test('ordered migration requires the original tuple, preserves receipts and freezes old/new submissions', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const owner = await f.user(), reviewer = await f.user('moderator');
  const old = createService(f.db, { publicationEnabled: true });
  const pending = await send(old, owner, f.guide, 'Legacy snapshot');
  await old.review(reviewer.id, pending.id, { decision: 'approve', expectedVersion: 1, note: 'Legacy receipt unchanged' });
  const before = (await f.db.query('SELECT * FROM submissions WHERE id=$1', [pending.id])).rows[0];
  const files = approvedFiles(before);
  await assert.rejects(migrate(f.db), /original legacy publication target/);
  assert.equal((await f.db.query('SELECT version FROM schema_migrations WHERE version=2')).rows.length, 0);
  assert.deepEqual(await migrate(f.db, { legacyTarget: legacy }), { applied: true, versions: [2] });
  assert.deepEqual(await migrate(f.db), { applied: false, versions: [] });
  await assert.rejects(migrate(f.db, { legacyTarget: { ...legacy, installationId: '99999' } }), /immutable original/);
  const migrated = (await f.db.query('SELECT * FROM submissions WHERE id=$1', [pending.id])).rows[0];
  assert.deepEqual(migrated.publication_target, legacy);
  assert.deepEqual(approvedFiles(migrated), files);
  assert.equal(migrated.content_hash, before.content_hash);
  await assert.rejects(f.db.query('UPDATE submissions SET publication_target=$2 WHERE id=$1', [pending.id, JSON.stringify(content)]), /immutable/);
  const other = (await old.getGuide('interface-guide')).document;
  const legacyInsert = await send(old, owner, other, 'Old-version insert after migration');
  assert.deepEqual((await f.db.query('SELECT publication_target FROM submissions WHERE id=$1', [legacyInsert.id])).rows[0].publication_target, legacy);
  assert.deepEqual((await f.db.query('SELECT publication_target FROM guides WHERE id=$1', [f.guide.id])).rows[0].publication_target, legacy);
});

test('explicit per-guide handoff drains legacy work, rechecks proof and freezes new target at creation', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const owner = await f.user(), reviewer = await f.user('moderator');
  const old = createService(f.db, { publicationEnabled: true });
  const legacySubmission = await send(old, owner, f.guide, 'Old pending review');
  await migrate(f.db, { legacyTarget: legacy });
  const service = createService(f.db, options);
  await assert.rejects(handoff(f), error => error.code === 'publication_handoff_pending');
  await service.review(reviewer.id, legacySubmission.id, { decision: 'reject', expectedVersion: 1, note: 'Close the old review before handoff' });
  await assert.rejects(handoffGuidePublication(f.db, { guideId: f.guide.id, target: content, expectedRevision: 1, expectedHash: documentHash(f.guide), contentCommit: 'a'.repeat(40), verifyContent: async () => false, reason: 'Unverified test' }), error => error.code === 'publication_handoff_unverified');
  let proof;
  assert.equal((await handoffGuidePublication(f.db, { guideId: f.guide.id, target: content, expectedRevision: 1, expectedHash: documentHash(f.guide), contentCommit: 'a'.repeat(40), verifyContent: async value => { proof = value; return true; }, reason: 'Exact remote revision and hash verified' })).changed, true);
  assert.equal(proof.expectedRevision, 1);
  assert.equal(proof.contentHash, documentHash(f.guide));
  assert.equal((await handoff(f)).changed, false);
  const current = (await f.db.query('SELECT revision,publication_target FROM guides WHERE id=$1', [f.guide.id])).rows[0];
  assert.equal(current.revision, 1);
  assert.deepEqual(current.publication_target, content);
  const retried = await service.submit(owner.id, f.guide.id, { expectedVersion: 1, summary: 'Retry original version' });
  assert.equal(retried.id, legacySubmission.id, 'Idempotent retries preserve the original frozen destination');
  const fresh = await send(service, owner, f.guide, 'New content review', 1);
  const row = (await f.db.query('SELECT * FROM submissions WHERE id=$1', [fresh.id])).rows[0];
  assert.deepEqual(row.publication_target, content);
  const missing = createService(f.db, { ...options, publicationTargets: [legacy] });
  await assert.rejects(missing.review(reviewer.id, fresh.id, { decision: 'approve', expectedVersion: 1 }), error => error.code === 'publication_target_unknown');
  assert.equal((await service.getSubmission(reviewer.id, fresh.id)).status, 'submitted');
  await service.review(reviewer.id, fresh.id, { decision: 'approve', expectedVersion: 1 });
  await f.db.query('UPDATE publication_jobs SET provider=$2 WHERE submission_id=$1', [fresh.id, JSON.stringify({ pipeline: 'content-pin-v1', phase: 'website_update', number: 7, websiteNumber: 8, url: 'https://evil.example/private' })]);
  const reviewed = await service.getSubmission(reviewer.id, fresh.id), author = await service.getSubmission(owner.id, fresh.id);
  assert.equal(reviewed.publication.pipeline, 'content-pin-v1');
  assert.equal(reviewed.publication.phase, 'website_update');
  assert.equal(reviewed.publication.contentReviewUrl, 'https://github.com/pvme-wiki/guides/pull/7');
  assert.equal(reviewed.publication.websiteReviewUrl, 'https://github.com/example/private-guides/pull/8');
  assert.ok(!JSON.stringify(author.publication).includes('github.com'));
  assert.ok(!JSON.stringify(author.publication).includes('evil.example'));
  await assert.rejects(f.db.query('UPDATE guides SET publication_target=$2 WHERE id=$1', [f.guide.id, JSON.stringify(legacy)]), /explicit authority handoff/);
});

test('row-selected providers keep legacy work separate and wait for app pin and exact live evidence', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await migrate(f.db, { legacyTarget: legacy });
  const owner = await f.user(), reviewer = await f.user('moderator'), service = createService(f.db, options);
  const old = await send(service, owner, f.guide, 'Legacy target publication');
  await service.review(reviewer.id, old.id, { decision: 'approve', expectedVersion: 1 });
  const guide = (await service.getGuide('interface-guide')).document;
  await handoff(f, guide);
  const fresh = await send(service, owner, guide, 'Org target publication');
  await service.review(reviewer.id, fresh.id, { decision: 'approve', expectedVersion: 1 });
  let phase = 'content_review'; const calls = [];
  const legacyProvider = { ensurePullRequest: async () => ({ number: 1, branchSha: 'b'.repeat(40) }), reconcile: async (_row, info) => ({ state: 'awaiting_merge', provider: info }) };
  const contentProvider = {
    ensurePullRequest: async () => ({ pipeline: 'content-pin-v1', phase, number: 1, branchSha: 'c'.repeat(40) }),
    reconcile: async (_row, info) => ({ state: phase === 'content_review' ? 'awaiting_merge' : phase === 'live' ? 'published' : 'awaiting_deployment', provider: {
      ...info, phase, contentMerged: phase !== 'content_review', merged: ['deployment','live'].includes(phase),
      ...(phase !== 'content_review' ? { contentMergeSha: 'd'.repeat(40) } : {}),
      ...(['deployment','live'].includes(phase) ? { appMergeSha: 'e'.repeat(40) } : {}),
      ...(phase === 'live' ? { appCommit: 'f'.repeat(40), contentCommit: 'd'.repeat(40), deployedCommit: 'f'.repeat(40) } : {}),
    } }),
  };
  const jobs = createJobRunner(f.db, { resolve: async target => { calls.push(target.origin); return { target, provider: target.pipeline === 'legacy-v1' ? legacyProvider : contentProvider }; } }, { origin: f.config.origin, publicationTargets: registry });
  assert.equal((await jobs.runOne({ submissionId: old.id })).state, 'awaiting_merge');
  assert.equal((await jobs.runOne({ submissionId: fresh.id })).state, 'awaiting_merge');
  phase = 'website_update'; await jobs.wake(f.db, { targets: [content] });
  assert.equal((await jobs.runOne({ submissionId: fresh.id })).state, 'awaiting_deployment');
  assert.equal((await service.getGuide(guide.id)).revision, 1, 'Content merge alone never advances the app canonical baseline');
  phase = 'deployment'; await jobs.wake();
  assert.equal((await jobs.runOne({ submissionId: fresh.id })).state, 'awaiting_deployment');
  assert.equal((await service.getGuide(guide.id)).revision, 2);
  assert.equal((await service.getSubmission(owner.id, fresh.id)).status, 'publishing');
  phase = 'live'; await jobs.wake();
  assert.equal((await jobs.runOne({ submissionId: fresh.id })).state, 'published');
  assert.equal((await service.getGuide(guide.id)).revision, 2);
  assert.equal((await service.getSubmission(owner.id, fresh.id)).status, 'published');
  assert.ok(calls.includes('legacy-v1') && calls.includes('guides-v1'));
  await f.db.query("UPDATE publication_jobs SET available_at=now()+interval '1 hour' WHERE submission_id=$1", [old.id]);
  await assert.rejects(f.db.transaction(async q => { await jobs.wake(q, { targets: [legacy], includeLegacyUnbound: true }); throw Error('rollback wake'); }), /rollback wake/);
  assert.equal((await f.db.query('SELECT available_at>now() AS delayed FROM publication_jobs WHERE submission_id=$1', [old.id])).rows[0].delayed, true);
  await jobs.wake(f.db, { targets: [content] });
  assert.equal((await f.db.query('SELECT available_at>now() AS delayed FROM publication_jobs WHERE submission_id=$1', [old.id])).rows[0].delayed, true, 'Org webhook cannot wake legacy work');
});

test('destination validation and provider resolver reject identity substitution without external writes', async t => {
  assert.throws(() => validatePublicationTarget({ ...content, repository: { ...content.repository, id: '' } }));
  assert.throws(() => trustedPublicationTarget({ ...content, installationId: '999' }, registry), error => error.code === 'publication_target_unknown');
  const f = await fixture(); t.after(() => f.db.close()); await migrate(f.db, { legacyTarget: legacy });
  const owner = await f.user(), reviewer = await f.user('moderator'), service = createService(f.db, options);
  const submission = await send(service, owner, f.guide, 'Frozen destination test');
  await service.review(reviewer.id, submission.id, { decision: 'approve', expectedVersion: 1 });
  let writes = 0;
  const wrong = { resolve: async () => ({ target: content, provider: { ensurePullRequest: async () => { writes++; }, reconcile: async () => {} } }) };
  const result = await createJobRunner(f.db, wrong, { publicationTargets: registry }).runOne();
  assert.equal(result.state, 'blocked'); assert.equal(result.code, 'publication_target_unknown'); assert.equal(writes, 0);
});

test('fresh databases apply both ordered migrations once with an explicit immutable legacy binding', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  const db = { query: (sql, params = []) => pg.query(sql, params), transaction: fn => pg.transaction(q => fn({ query: (sql, params = []) => q.query(sql, params), exec: sql => q.exec(sql) })) };
  await assert.rejects(migrate(db), /original legacy publication target/);
  assert.equal((await db.query("SELECT to_regclass('public.schema_migrations') AS name")).rows[0].name, null, 'Failed setup rolls back the entire first migration too');
  assert.deepEqual(await migrate(db, { legacyTarget: legacy }), { applied: true, versions: [1,2] });
  assert.deepEqual(await migrate(db), { applied: false, versions: [] });
  assert.deepEqual((await db.query('SELECT legacy_target FROM publication_migration_settings')).rows[0].legacy_target, legacy);
});

test('legacy handoff cannot trust an unaudited replacement marker in mutable provider metadata', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await migrate(f.db, { legacyTarget: legacy });
  const owner = await f.user(), service = createService(f.db, options);
  const original = await send(service, owner, f.guide, 'Unresolved original snapshot');
  await f.db.query("INSERT INTO publication_jobs(submission_id,state,provider) VALUES($1,'blocked',$2)", [original.id, JSON.stringify({ replacementId: '00000000-0000-4000-8000-000000000001' })]);
  await assert.rejects(handoff(f), error => error.code === 'publication_handoff_pending');
  assert.deepEqual((await f.db.query('SELECT publication_target FROM guides WHERE id=$1', [f.guide.id])).rows[0].publication_target, legacy);
});
