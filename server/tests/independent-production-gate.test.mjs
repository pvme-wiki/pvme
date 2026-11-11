import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './harness.mjs';
import { createService } from '../service.mjs';
import { createJobRunner } from '../jobs.mjs';
import { approvedFiles } from '../github.mjs';
import { documentHash } from '../core.mjs';
import { verifyPublicationGate } from '../publication-gate.mjs';
import { checkProductionPublication } from '../../scripts/check-publication.mjs';

async function gateFixture() {
  const f = await fixture();
  const author = await f.user(), reviewer = await f.user('moderator');
  const service = createService(f.db, { publicationEnabled: true });
  const approve = async (guideId, title) => {
    const document = structuredClone((await service.getGuide(guideId)).document); document.title = title;
    await service.saveDraft(author.id, guideId, { document, expectedVersion: 0, baseRevision: 1 });
    const pending = await service.submit(author.id, guideId, { expectedVersion: 1, summary: 'Gate fixture contribution' });
    await service.review(reviewer.id, pending.id, { expectedVersion: 1, decision: 'approve', note: 'Gate fixture approval' });
    const row = (await f.db.query('SELECT * FROM submissions WHERE id=$1', [pending.id])).rows[0];
    return { document, contentHash: documentHash(document), receipt: approvedFiles(row)[`content/reviews/${row.id}.json`] };
  };
  const runner = createJobRunner(f.db, {
    ensurePullRequest: async row => ({ number: 1, branchSha: 'a'.repeat(40), branch: `pvme/review-${row.id}` }),
    reconcile: async (_row, provider) => ({ state: 'published', provider: { ...provider, merged: true, mergeSha: 'b'.repeat(40), deployedCommit: 'b'.repeat(40) } }),
  }, { origin: f.config.origin });
  return { ...f, author, reviewer, service, approve, runner };
}

test('independent: production gate requires the exact DB approval, receipt and current canonical revision', async t => {
  const f = await gateFixture(); t.after(() => f.db.close());
  const entry = await f.approve('arch-glacor-basic', 'Approved gate fixture');
  assert.equal((await verifyPublicationGate(f.db, [entry])).verifiedCount, 1);
  const altered = structuredClone(entry); altered.receipt.reviewNote = 'Unapproved changed review note';
  await assert.rejects(verifyPublicationGate(f.db, [altered]), error => error.code === 'approval_content_mismatch');
  const text = structuredClone(entry); text.document.title = 'Unapproved text';
  await assert.rejects(verifyPublicationGate(f.db, [text]), error => error.code === 'approval_content_mismatch');
  const forged = structuredClone(entry); forged.receipt.submissionId = randomUUID();
  await assert.rejects(verifyPublicationGate(f.db, [forged]), error => error.code === 'approval_not_verified');
  assert.equal((await f.runner.runOne({ submissionId: entry.receipt.submissionId })).state, 'published');
  assert.equal((await verifyPublicationGate(f.db, [entry])).verifiedCount, 1);
  const newer = { ...structuredClone(entry.document), title: 'A newer canonical version' };
  await f.db.query('INSERT INTO guide_revisions(guide_id,revision,document,content_hash) VALUES($1,3,$2,$3)', [entry.document.id, JSON.stringify(newer), documentHash(newer)]);
  await f.db.query('UPDATE guides SET revision=3 WHERE id=$1', [entry.document.id]);
  await assert.rejects(verifyPublicationGate(f.db, [entry]), error => error.code === 'stale_production_content');
});

test('independent: production gate rejects DB-only supersession and unavailable authority without leaking errors', async t => {
  const f = await gateFixture(); t.after(() => f.db.close());
  const entry = await f.approve('arch-glacor-basic', 'Approved gate fixture');
  await assert.rejects(verifyPublicationGate(null, [entry]), error => error.code === 'publication_gate_unavailable');
  await assert.rejects(verifyPublicationGate({ query: async () => { throw new Error('postgres://private-password@secret-host/private-account'); } }, [entry]), error => error.code === 'publication_gate_unavailable' && !error.message.includes('secret') && !error.message.includes('password'));
  await f.db.query('UPDATE publication_jobs SET provider=$2 WHERE submission_id=$1', [entry.receipt.submissionId, JSON.stringify({ replacementId: randomUUID() })]);
  await assert.rejects(verifyPublicationGate(f.db, [entry]), error => error.code === 'approval_superseded');
  await f.db.query("UPDATE publication_jobs SET provider='{}' WHERE submission_id=$1", [entry.receipt.submissionId]);
  await f.db.query('INSERT INTO audit_events(id,actor_id,action,subject_id,data) VALUES($1,$2,$3,$4,$5)', [randomUUID(), f.author.id, 'submission.resubmitted', entry.receipt.submissionId, '{}']);
  await assert.rejects(verifyPublicationGate(f.db, [entry]), error => error.code === 'approval_superseded');
});

test('independent: deleting one or all merged overlays cannot silently restore original reader baselines', async t => {
  const f = await gateFixture(); t.after(() => f.db.close());
  const first = await f.approve('arch-glacor-basic', 'First approved guide');
  const second = await f.approve('interface-guide', 'Second approved guide');
  for (const entry of [first, second]) assert.equal((await f.runner.runOne({ submissionId: entry.receipt.submissionId })).state, 'published');
  assert.equal((await verifyPublicationGate(f.db, [first, second])).verifiedCount, 2);
  await assert.rejects(verifyPublicationGate(f.db, [first]), /missing|omit|inventory|canonical|rollback/i);
  await assert.rejects(verifyPublicationGate(f.db, []), /missing|omit|inventory|canonical|rollback/i);
});

test('independent: production wrapper never bypasses authority for an empty build and offline fixtures never contact it', async () => {
  const empty = new Map();
  const overlay = new Map([['synthetic', { document: { id: 'synthetic' }, receipt: { submissionId: randomUUID() } }]]);
  for (const published of [empty, overlay]) {
    await assert.rejects(checkProductionPublication('.', published, empty, { VERCEL_ENV: 'production' }), /requires.*approval database/);
    assert.deepEqual(await checkProductionPublication('.', published, empty, { VERCEL_ENV: 'preview', DATABASE_URL: 'not-a-database-url' }), { verifiedCount: 0 });
  }
  await assert.rejects(checkProductionPublication('.', empty, empty, { VERCEL_ENV: 'production', DATABASE_URL: 'invalid://private-secret-password@secret-host' }), error => /could not verify/.test(error.message) && !error.message.includes('secret') && !error.message.includes('password'));
});

test('independent: baseline-only production still proves its full catalog against immutable DB originals', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const rows = (await f.db.query('SELECT guide_id,document FROM guide_revisions WHERE revision=1')).rows;
  const baselines = new Map(rows.map(row => [row.guide_id, row.document]));
  assert.equal((await verifyPublicationGate(f.db, [], { expectedBaselines: baselines })).verifiedCount, 0);
  const tampered = new Map(baselines); tampered.set(f.guide.id, { ...structuredClone(f.guide), title: 'Never approved original replacement' });
  await assert.rejects(verifyPublicationGate(f.db, [], { expectedBaselines: tampered }), error => error.code === 'catalog_baseline_mismatch');
  const omitted = new Map(baselines); omitted.delete(f.guide.id);
  await assert.rejects(verifyPublicationGate(f.db, [], { expectedBaselines: omitted }), error => error.code === 'missing_catalog_guide');
  const unseeded = new Map(baselines); unseeded.set('unseeded-guide', { ...structuredClone(f.guide), id: 'unseeded-guide' });
  await assert.rejects(verifyPublicationGate(f.db, [], { expectedBaselines: unseeded }), error => error.code === 'catalog_not_seeded');
});
