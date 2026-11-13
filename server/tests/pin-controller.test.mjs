import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './harness.mjs';
import { migrate } from '../manage.mjs';
import { documentHash } from '../core.mjs';
import { createPinController, handoffGuidePublication } from '../publication-targets.mjs';
const legacy = { pipeline: 'legacy-v1', origin: 'legacy-v1', repository: { id: '101', owner: 'example', repo: 'private-guides', base: 'main' }, installationId: '12345' };
const target = { pipeline: 'content-pin-v1', origin: 'guides-v1', repository: { id: '202', owner: 'pvme-wiki', repo: 'guides', base: 'main' }, installationId: '67890' };
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const gate = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
async function setup(t) {
  const f = await fixture(); t.after(() => f.db.close()); await migrate(f.db, { legacyTarget: legacy });
  return { ...f, controller: createPinController(f.db) };
}
async function handoff(f, guide = f.guide) {
  return handoffGuidePublication(f.db, { guideId: guide.id, target, expectedRevision: 1, expectedHash: documentHash(guide), contentCommit: A, verifyContent: async () => true, reason: 'Verified isolated pin fixture' });
}

test('pin checkpoints persist metadata and atomically mirror the newest pin to every handed-off guide', async t => {
  const f = await setup(t); await handoff(f);
  await f.controller.withLease(target.origin, async lease => {
    const first = await lease.read(); assert.equal(first.version, 0); assert.equal(first.contentCommit, null);
    const saved = await lease.checkpoint({ expectedVersion: 0, contentCommit: A, provider: { websiteNumber: 7 } });
    assert.equal(saved.version, 1);
    assert.deepEqual((await f.db.query('SELECT publication_pin FROM guides WHERE id=$1', [f.guide.id])).rows[0].publication_pin, { contentCommit: A, version: 1 });
  });
  await f.controller.withLease(target.origin, async lease => {
    const restored = await lease.read(); assert.equal(restored.provider.websiteNumber, 7);
    const updated = await lease.checkpoint({ expectedVersion: restored.version, contentCommit: B, appCommit: C, provider: { websiteNumber: 8 }, isDescendant: async (base, head) => base === A && head === B });
    assert.equal(updated.version, 2); assert.equal(updated.appCommit, C);
  });
  const other = (await f.db.query("SELECT document FROM guide_revisions WHERE guide_id='interface-guide' AND revision=1")).rows[0].document;
  await handoff(f, other);
  for (const id of [f.guide.id, other.id]) {
    const row = (await f.db.query('SELECT revision,publication_target,publication_pin FROM guides WHERE id=$1', [id])).rows[0];
    assert.equal(row.revision, 1);
    assert.deepEqual(row.publication_target, target);
    assert.deepEqual(row.publication_pin, { contentCommit: B, version: 2 });
  }
  await assert.rejects(f.db.query('UPDATE guides SET publication_pin=$2 WHERE id=$1', [f.guide.id, JSON.stringify({ contentCommit: A, version: 1 })]), /durable controller/);
});

test('an origin lease serializes workers and rejects stale, backward or divergent pin candidates', async t => {
  const f = await setup(t), entered = gate(), release = gate();
  const first = f.controller.withLease(target.origin, async lease => { entered.resolve(); await release.promise; return lease.checkpoint({ expectedVersion: 0, contentCommit: B, provider: { websiteNumber: 2 } }); });
  await entered.promise;
  await assert.rejects(f.controller.withLease(target.origin, async () => {}), error => error.code === 'pin_busy' && error.retryable);
  release.resolve(); await first;
  await f.controller.withLease(target.origin, async lease => {
    await assert.rejects(lease.checkpoint({ expectedVersion: 0, contentCommit: C, isDescendant: async () => true }), error => error.code === 'pin_conflict');
    await assert.rejects(lease.checkpoint({ expectedVersion: 1, contentCommit: A, isDescendant: async () => false }), error => error.code === 'pin_not_forward');
    await assert.rejects(lease.checkpoint({ expectedVersion: 1, contentCommit: C }), error => error.code === 'pin_not_forward');
    assert.equal((await lease.read()).contentCommit, B);
  });
});

test('an expired worker cannot checkpoint or release a newer lease after network work finishes late', async t => {
  const f = await setup(t), firstEntered = gate(), letFirstFinish = gate(), secondEntered = gate(), letSecondFinish = gate();
  const stale = f.controller.withLease(target.origin, async lease => {
    firstEntered.resolve(); await letFirstFinish.promise;
    await assert.rejects(lease.checkpoint({ expectedVersion: 0, contentCommit: A }), error => error.code === 'lease_superseded');
  });
  await firstEntered.promise;
  await f.db.query("UPDATE publication_pin_controllers SET lease_until=now()-interval '1 second' WHERE origin=$1", [target.origin]);
  const current = f.controller.withLease(target.origin, async lease => {
    await lease.checkpoint({ expectedVersion: 0, contentCommit: B, provider: { websiteNumber: 3 } });
    secondEntered.resolve(); await letSecondFinish.promise;
    assert.equal((await lease.read()).contentCommit, B, 'An old worker cannot release a newer worker’s token');
  });
  await secondEntered.promise;
  letFirstFinish.resolve(); await stale;
  letSecondFinish.resolve(); await current;
  const row = (await f.db.query('SELECT content_commit,lease_token FROM publication_pin_controllers WHERE origin=$1', [target.origin])).rows[0];
  assert.equal(row.content_commit, B); assert.equal(row.lease_token, null);
});

test('failed bridge work releases its lease but keeps the durable recovery checkpoint', async t => {
  const f = await setup(t);
  await assert.rejects(f.controller.withLease(target.origin, async lease => {
    await lease.checkpoint({ expectedVersion: 0, contentCommit: A, provider: { websiteNumber: 10, branchSha: B } });
    throw Error('Lost response after creating the website PR');
  }), /Lost response/);
  await f.controller.withLease(target.origin, async lease => {
    assert.deepEqual((await lease.read()).provider, { websiteNumber: 10, branchSha: B });
  });
});
