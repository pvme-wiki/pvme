import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadHostedContent } from './hosted-content.mjs';
import { documentHash } from '../server/core.mjs';

function fixture(t, { oldRevision = 1, newRevision = 2, oldDate = '2026-11-11T10:00:00.000Z', newDate = '2026-11-11T11:00:00.000Z' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvme-stale-publication-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = JSON.parse(fs.readFileSync(new URL('../editor/content/arch-glacor-basic.json', import.meta.url)));
  const older = { ...structuredClone(original), title: 'Older approved wording' };
  const newer = { ...structuredClone(original), title: 'Newer approved wording' };
  const write = (relative, value) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write('editor/content/catalog.json', [{ id: original.id, file: `${original.id}.json` }]);
  write(`editor/content/${original.id}.json`, original);
  const receipt = (document, revision, approvedAt, baseline) => ({
    schemaVersion: 1, submissionId: randomUUID(), guideId: original.id,
    baseRevision: revision, baselineHash: documentHash(baseline), contentHash: documentHash(document),
    draftVersion: revision, approvedAt, contributorId: randomUUID(), reviewerId: randomUUID(),
  });
  const oldReceipt = receipt(older, oldRevision, oldDate, original);
  const newReceipt = receipt(newer, newRevision, newDate, newRevision > oldRevision ? older : original);
  for (const value of [oldReceipt, newReceipt]) write(`content/reviews/${value.submissionId}.json`, value);
  const publish = document => write(`content/guides/${original.id}.json`, document);
  publish(newer);
  return { root, original, older, newer, oldReceipt, newReceipt, publish, write };
}

test('independent: a stale PR cannot roll the public build back while a newer approved receipt remains', t => {
  const f = fixture(t);
  assert.equal(loadHostedContent(f.root).release.guides[f.original.id].submissionId, f.newReceipt.submissionId);
  f.publish(f.older);
  assert.throws(() => loadHostedContent(f.root), /stale|newer|latest|rollback|current|receipt/i);
});

test('independent: conflicting same-baseline approvals fail closed rather than selecting by timestamp', t => {
  const f = fixture(t, { oldRevision: 1, newRevision: 1 });
  assert.throws(() => loadHostedContent(f.root), /fork|conflict|lineage|receipt/i);
  f.publish(f.older);
  assert.throws(() => loadHostedContent(f.root), /fork|conflict|lineage|receipt/i);
});

test('independent: canonical revision outranks receipt timestamps when preventing build rollback', t => {
  const f = fixture(t, { oldDate: '2026-11-11T12:00:00.000Z', newDate: '2026-11-11T11:00:00.000Z' });
  assert.equal(loadHostedContent(f.root).release.guides[f.original.id].submissionId, f.newReceipt.submissionId);
  f.publish(f.older);
  assert.throws(() => loadHostedContent(f.root), /stale|newer|latest|rollback|current|receipt/i);
});

test('independent: a valid multi-step receipt chain may keep history without publishing old content', t => {
  const f = fixture(t);
  const terminal = { ...structuredClone(f.newer), title: 'Third independently approved version' };
  const finalReceipt = { ...f.newReceipt, submissionId: randomUUID(), baseRevision: 3, baselineHash: documentHash(f.newer), contentHash: documentHash(terminal), approvedAt: '2026-11-11T09:00:00.000Z' };
  f.write(`content/reviews/${finalReceipt.submissionId}.json`, finalReceipt);
  f.publish(terminal);
  const result = loadHostedContent(f.root);
  assert.equal(result.release.guides[f.original.id].contentHash, documentHash(terminal));
  assert.equal(result.release.guides[f.original.id].submissionId, finalReceipt.submissionId);
});

test('independent: missing receipt revisions and a wrong baseline hash cannot invent a publication lineage', t => {
  const f = fixture(t);
  f.newReceipt.baseRevision = 3;
  f.write(`content/reviews/${f.newReceipt.submissionId}.json`, f.newReceipt);
  assert.throws(() => loadHostedContent(f.root), /missing|revision|lineage|receipt|gap/i);
  f.newReceipt.baseRevision = 2; f.newReceipt.baselineHash = documentHash(f.original);
  f.write(`content/reviews/${f.newReceipt.submissionId}.json`, f.newReceipt);
  assert.throws(() => loadHostedContent(f.root), /baseline|hash|lineage|receipt/i);
});

test('independent: duplicate approvals for identical content at the same revision do not create a fork', t => {
  const f = fixture(t);
  const duplicate = { ...f.oldReceipt, submissionId: randomUUID(), approvedAt: '2026-11-11T12:00:00.000Z' };
  f.write(`content/reviews/${duplicate.submissionId}.json`, duplicate);
  const result = loadHostedContent(f.root);
  assert.equal(result.release.guides[f.original.id].submissionId, f.newReceipt.submissionId);
});
