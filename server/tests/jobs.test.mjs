import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './harness.mjs';
import { createService } from '../service.mjs';
import { createJobRunner } from '../jobs.mjs';
import { PublicationError } from '../github.mjs';
const id = 'arch-glacor-basic';
async function approved(f, { title = 'Approved title', owner, reviewer } = {}) {
  owner ||= await f.user(); reviewer ||= await f.user('moderator');
  const service = createService(f.db, { publicationEnabled: true }), current = await service.getDraft(owner.id, id);
  await service.saveDraft(owner.id, id, { document: f.changed(title), expectedVersion: current?.version || 0, baseRevision: 1 });
  const submission = await service.submit(owner.id, id, { expectedVersion: (current?.version || 0) + 1, summary: 'Improve the guide' });
  await service.review(reviewer.id, submission.id, { decision: 'approve', expectedVersion: 1 }); return { submission, owner, reviewer, service };
}
const info = { number: 1, branch: 'test', branchSha: 'a'.repeat(40) };
test('publishing waits for verified deployment; canonical advances after merge only', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const a = await approved(f); let state = 'awaiting_merge', ensures = 0;
  const provider = {
    ensurePullRequest: async row => { ensures++; assert.equal(row.document.title, 'Approved title'); return info; },
    reconcile: async () => ({ state, provider: { ...info, ...(state !== 'awaiting_merge' ? { merged: true, mergeSha: 'b'.repeat(40) } : {}), ...(state === 'published' ? { deployedCommit: 'b'.repeat(40) } : {}) } }),
  };
  const jobs = createJobRunner(f.db, provider, { origin: f.config.origin });
  assert.equal((await jobs.runOne()).state, 'awaiting_merge'); assert.equal((await a.service.getSubmission(a.owner.id, a.submission.id)).status, 'publishing'); assert.equal((await a.service.getGuide(id)).revision, 1);
  state = 'awaiting_deployment'; await jobs.wake(); assert.equal((await jobs.runOne()).state, 'awaiting_deployment'); assert.equal((await a.service.getGuide(id)).revision, 2); assert.equal((await a.service.getSubmission(a.owner.id, a.submission.id)).status, 'publishing');
  state = 'published'; await jobs.wake(); assert.equal((await jobs.runOne()).state, 'published'); assert.equal((await a.service.getSubmission(a.owner.id, a.submission.id)).status, 'published'); assert.equal((await a.service.getGuide(id)).revision, 2); assert.equal(ensures, 1); assert.equal((await jobs.runOne()).state, 'idle');
  assert.equal(Number((await f.db.query("SELECT count(*) FROM audit_events WHERE action='publication.deployed'")).rows[0].count), 1);
});
test('uncertain writes retry same submission; expired leases recover and failures are durable', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const a = await approved(f); let calls = 0;
  const provider = {
    ensurePullRequest: async row => { calls++; assert.equal(row.id, a.submission.id); if (calls === 1) throw new PublicationError('provider_unavailable', 'lost acknowledgement', { retryable: true }); return info; },
    reconcile: async () => ({ state: 'awaiting_merge', provider: info }),
  };
  const jobs = createJobRunner(f.db, provider, { origin: f.config.origin });
  assert.equal((await jobs.runOne()).state, 'retry'); assert.equal((await f.db.query('SELECT last_error FROM publication_jobs')).rows[0].last_error, 'provider_unavailable');
  await jobs.wake(); assert.equal((await jobs.runOne()).state, 'awaiting_merge'); assert.equal(calls, 2);
  await f.db.query("UPDATE publication_jobs SET state='working',lease_until=now()-interval '1 second',lease_token='12345678-1234-4234-8234-123456789abc'"); assert.equal((await jobs.runOne()).state, 'awaiting_merge');
  const blocked = createJobRunner(f.db, { ensurePullRequest: async () => info, reconcile: async () => { throw new PublicationError('source_conflict', 'changed'); } }, { origin: f.config.origin });
  await jobs.wake(); assert.equal((await blocked.runOne()).state, 'blocked');
  await assert.rejects(jobs.retry(a.owner.id, a.submission.id), error => error.code === 'forbidden');
  const admin = await f.user('admin'); await assert.rejects(jobs.retry(admin.id, a.submission.id), error => error.code === 'fresh_review_required');
  await f.db.query("UPDATE publication_jobs SET last_error='provider_unavailable' WHERE submission_id=$1", [a.submission.id]);
  assert.equal((await jobs.retry(admin.id, a.submission.id)).state, 'queued');
});
test('parallel workers cannot duplicate a live lease or leapfrog older guide review', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await approved(f); const second = await approved(f, { title: 'Second approval' });
  let calls = 0, release; const gate = new Promise(resolve => release = resolve);
  const provider = { ensurePullRequest: async () => { calls++; await gate; return info; }, reconcile: async () => ({ state: 'awaiting_merge', provider: info }) };
  const jobs = createJobRunner(f.db, provider, { origin: f.config.origin }), running = jobs.runOne();
  while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await jobs.runOne()).state, 'idle'); assert.equal((await jobs.runOne({ submissionId: second.submission.id })).state, 'idle'); release(); assert.equal((await running).state, 'awaiting_merge'); assert.equal(calls, 1);
});
test('old workers cannot overwrite replacement lease outcome', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await approved(f);
  let release, started; const start = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
  const jobs = createJobRunner(f.db, { ensurePullRequest: async () => { started(); await gate; return info; }, reconcile: async () => ({ state: 'awaiting_merge', provider: info }) }, { origin: f.config.origin });
  const running = jobs.runOne(); await start;
  await f.db.query("UPDATE publication_jobs SET lease_token='12345678-1234-4234-8234-123456789abc',state='working'"); release(); assert.equal((await running).state, 'superseded'); assert.equal((await f.db.query('SELECT state FROM publication_jobs')).rows[0].state, 'working');
});
