import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './harness.mjs';
import { createService } from '../service.mjs';
import { approvedFiles } from '../github.mjs';
import { documentHash } from '../core.mjs';
import { verifyPublicationGate } from '../publication-gate.mjs';
const guideId = 'arch-glacor-basic';
async function approvedFixture() {
  const f = await fixture(), owner = await f.user(), reviewer = await f.user('moderator');
  const service = createService(f.db, { publicationEnabled: true });
  await service.saveDraft(owner.id, guideId, { document: f.changed('Approved live candidate'), expectedVersion: 0, baseRevision: 1 });
  const submitted = await service.submit(owner.id, guideId, { expectedVersion: 1, summary: 'Reviewed wording' });
  await service.review(reviewer.id, submitted.id, { decision: 'approve', expectedVersion: 1, note: 'Independently checked' });
  const row = (await f.db.query('SELECT * FROM submissions WHERE id=$1', [submitted.id])).rows[0];
  const entry = { document: row.document, contentHash: row.content_hash, receipt: approvedFiles(row)[`content/reviews/${row.id}.json`] };
  return { ...f, owner, reviewer, service, row, entry, published: new Map([[guideId, entry]]) };
}
const rejectsCode = code => error => { assert.equal(error.code, code); return true; };
test('production gate reads immutable approval, exact receipt and canonical state without mutating', async t => {
  const f = await approvedFixture(); t.after(() => f.db.close());
  const queries = [];
  const readonly = { query(sql, params) { queries.push(sql); assert.match(sql, /^SELECT\s/); return f.db.query(sql, params); } };
  assert.deepEqual(await verifyPublicationGate(readonly, f.published), { verifiedCount: 1, submissionIds: [f.row.id] });
  assert.equal(queries.length, 1);
  await f.db.query('INSERT INTO guide_revisions(guide_id,revision,document,content_hash,publication_id) VALUES($1,2,$2,$3,$4)', [guideId, JSON.stringify(f.row.document), f.row.content_hash, f.row.id]);
  await f.db.query('UPDATE guides SET revision=2 WHERE id=$1', [guideId]);
  assert.equal((await verifyPublicationGate(f.db, f.published)).verifiedCount, 1, 'own verified merged revision can deploy');
});
test('production gate fails closed without DB, hides connection errors, and allows empty baseline-only content', async () => {
  await assert.rejects(verifyPublicationGate(null, new Map()), rejectsCode('publication_gate_unavailable'));
  assert.deepEqual(await verifyPublicationGate({ query: async () => ({ rows: [{ approvals: [], canonical_guides: [] }] }) }, new Map()), { verifiedCount: 0, submissionIds: [] });
  const entry = { document: { id: guideId }, receipt: { submissionId: randomUUID() } };
  await assert.rejects(verifyPublicationGate(null, [entry]), rejectsCode('publication_gate_unavailable'));
  const secret = 'postgres://user:do-not-log@db.example/database';
  await assert.rejects(verifyPublicationGate({ query() { throw Error(secret); } }, [entry]), error => { assert.equal(error.code, 'publication_gate_unavailable'); assert.ok(!error.message.includes(secret)); return true; });
});
test('production gate rejects changed wording or any changed receipt fact even with a matching historical hash', async t => {
  const f = await approvedFixture(); t.after(() => f.db.close());
  for (const field of ['summary', 'reviewNote', 'createdAt', 'approvedAt', 'contributorId', 'reviewerId', 'draftVersion', 'baseRevision', 'baselineHash']) {
    const altered = structuredClone(f.entry);
    altered.receipt[field] = typeof altered.receipt[field] === 'number' ? altered.receipt[field] + 1 : `${altered.receipt[field]}-changed`;
    await assert.rejects(verifyPublicationGate(f.db, [altered]), rejectsCode('approval_content_mismatch'), field);
  }
  const changed = structuredClone(f.entry); changed.document.title = 'Never reviewed'; changed.contentHash = documentHash(changed.document); changed.receipt.contentHash = changed.contentHash;
  await assert.rejects(verifyPublicationGate(f.db, [changed]), rejectsCode('approval_content_mismatch'));
});
test('DB-only resubmission blocks original Git receipt before any replacement receipt reaches Git', async t => {
  const f = await approvedFixture(); t.after(() => f.db.close());
  await f.db.query("UPDATE publication_jobs SET state='blocked',last_error='branch_conflict' WHERE submission_id=$1", [f.row.id]);
  await f.service.saveDraft(f.owner.id, guideId, { document: f.changed('Fresh correction still awaiting review'), expectedVersion: 1, baseRevision: 1 });
  const replacement = await f.service.resubmit(f.owner.id, f.row.id, { expectedVersion: f.row.version, expectedDraftVersion: 2, summary: 'New review required' });
  assert.equal(replacement.status, 'submitted');
  await assert.rejects(verifyPublicationGate(f.db, f.published), rejectsCode('approval_superseded'));
  await f.db.query("UPDATE publication_jobs SET provider=provider-'replacementId',state='queued' WHERE submission_id=$1", [f.row.id]);
  await assert.rejects(verifyPublicationGate(f.db, f.published), rejectsCode('approval_superseded'), 'append-only audit supersession is also authoritative');
});
test('an older valid Git commit cannot roll production back after a newer canonical revision', async t => {
  const f = await approvedFixture(); t.after(() => f.db.close());
  // Identical wording is insufficient: the canonical revision belongs to another approval.
  await f.db.query('INSERT INTO guide_revisions(guide_id,revision,document,content_hash,publication_id) VALUES($1,2,$2,$3,$4)', [guideId, JSON.stringify(f.row.document), f.row.content_hash, randomUUID()]);
  await f.db.query('UPDATE guides SET revision=2 WHERE id=$1', [guideId]);
  await assert.rejects(verifyPublicationGate(f.db, f.published), rejectsCode('stale_production_content'));
});
test('missing, blocked or non-independent approval is never production authority', async t => {
  const f = await approvedFixture(); t.after(() => f.db.close());
  await f.db.query("UPDATE publication_jobs SET state='blocked',last_error='source_conflict' WHERE submission_id=$1", [f.row.id]);
  await assert.rejects(verifyPublicationGate(f.db, f.published), rejectsCode('publication_blocked'));
  await f.db.query("UPDATE publication_jobs SET state='queued' WHERE submission_id=$1", [f.row.id]);
  await f.db.query('UPDATE submissions SET reviewer_id=owner_id WHERE id=$1', [f.row.id]);
  await assert.rejects(verifyPublicationGate(f.db, f.published), rejectsCode('approval_not_verified'));
  const unknown = structuredClone(f.entry); unknown.receipt.submissionId = randomUUID();
  await assert.rejects(verifyPublicationGate(f.db, [unknown]), rejectsCode('approval_not_verified'));
});

test('production gate checks complete canonical inventory even when every overlay is removed', async t => {
  const f = await approvedFixture(); t.after(() => f.db.close());
  await f.db.query('INSERT INTO guide_revisions(guide_id,revision,document,content_hash,publication_id) VALUES($1,2,$2,$3,$4)', [guideId, JSON.stringify(f.row.document), f.row.content_hash, f.row.id]);
  await f.db.query('UPDATE guides SET revision=2 WHERE id=$1', [guideId]);
  await assert.rejects(verifyPublicationGate(f.db, new Map()), rejectsCode('missing_production_content'));
  assert.equal((await verifyPublicationGate(f.db, f.published)).verifiedCount, 1);
});

test('production baseline inventory must be completely seeded and cannot be silently changed', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const rows = (await f.db.query('SELECT guide_id,document FROM guide_revisions WHERE revision=1')).rows;
  const baselines = new Map(rows.map(row => [row.guide_id, row.document]));
  assert.equal((await verifyPublicationGate(f.db, new Map(), { expectedBaselines: baselines })).verifiedCount, 0);
  const unseeded = new Map(baselines); unseeded.set('not-seeded', { ...f.guide, id: 'not-seeded' });
  await assert.rejects(verifyPublicationGate(f.db, new Map(), { expectedBaselines: unseeded }), rejectsCode('catalog_not_seeded'));
  const changed = new Map(baselines); changed.set(guideId, f.changed('Unreviewed baseline edit'));
  await assert.rejects(verifyPublicationGate(f.db, new Map(), { expectedBaselines: changed }), rejectsCode('catalog_baseline_mismatch'));
  const omitted = new Map(baselines); omitted.delete(guideId);
  await assert.rejects(verifyPublicationGate(f.db, new Map(), { expectedBaselines: omitted }), rejectsCode('missing_catalog_guide'));
});
