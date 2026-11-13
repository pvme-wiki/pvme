import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadHostedContent } from './hosted-content.mjs';
import { loadBuildContent } from './load-build-content.mjs';
import { documentHash } from '../server/core.mjs';
const appCommit = 'a'.repeat(40), contentCommit = 'c'.repeat(40);
const repository = { id: 51, owner: 'private-org', repo: 'guides', base: 'main' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvme-split-loader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = JSON.parse(fs.readFileSync(new URL('../editor/content/arch-glacor-basic.json', import.meta.url)));
  const changed = { ...structuredClone(original), title: 'Reviewed remote guide title' };
  const receipt = { schemaVersion: 1, submissionId: randomUUID(), guideId: original.id, baseRevision: 1, baselineHash: documentHash(original), contentHash: documentHash(changed), draftVersion: 1, summary: 'private-summary-sentinel', reviewNote: 'private-review-sentinel', approvedAt: '2026-11-13T12:00:00.000Z', createdAt: '2026-11-13T11:00:00.000Z', contributorId: randomUUID(), reviewerId: randomUUID() };
  const write = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, JSON.stringify(value)); };
  write('editor/content/catalog.json', [{id:original.id,file:original.id+'.json'}]);
  write('editor/content/'+original.id+'.json', original);
  const pin = {schemaVersion:1,mode:'active',origin:'guides-v1',repository,contentCommit,manifestSha256:'b'.repeat(64),guideIds:[original.id]};
  const store = {pin,guides:new Map([[original.id,{document:changed,contentHash:receipt.contentHash,baselineHash:receipt.baselineHash,revision:2}]])};
  const env = {GUIDE_STORE_REPOSITORY_ID:'51',GUIDE_STORE_OWNER:repository.owner,GUIDE_STORE_REPO:repository.repo,GUIDE_STORE_BASE_BRANCH:repository.base};
  return {root,original,changed,receipt,write,pin,store,env};
}
test('active remote overlay uses complete private app receipt lineage and explicit app/content commits', t => {
  const f=fixture(t); f.write('content/reviews/'+f.receipt.submissionId+'.json',f.receipt);
  const built=loadHostedContent(f.root,appCommit,{guideStore:f.store});
  assert.equal(built.published.get(f.original.id).document.title,f.changed.title);
  assert.equal(built.release.commit,appCommit); assert.equal(built.release.appCommit,appCommit);
  assert.equal(built.release.contentCommit,contentCommit); assert.equal(built.release.contentOrigin,'guides-v1');
  for(const secret of [f.receipt.submissionId,f.receipt.contributorId,f.receipt.reviewerId,f.receipt.summary,f.receipt.reviewNote,repository.owner+'/'+repository.repo]) assert.ok(!JSON.stringify(built.release).includes(secret));
});
test('a content document without its exact private receipt or revision cannot enter output', t => {
  const f=fixture(t);
  assert.throws(()=>loadHostedContent(f.root,appCommit,{guideStore:f.store}),/receipt/);
  f.write('content/reviews/'+f.receipt.submissionId+'.json',f.receipt);
  f.store.guides.get(f.original.id).revision=3;
  assert.throws(()=>loadHostedContent(f.root,appCommit,{guideStore:f.store}),/revision/);
});
test('shadow content is validated without changing legacy reader identity or source', async t => {
  const f=fixture(t); f.pin.mode='shadow'; f.write('content/guide-store.json',f.pin);
  let fetched=0;
  const built=await loadBuildContent(f.root,appCommit,{env:f.env,fetchStore:async()=>{fetched++;return f.store;}});
  assert.equal(fetched,1); assert.equal(built.published.size,0); assert.deepEqual(built.release,{commit:appCommit,guides:{}});
});
test('pin mismatch and fetch failure stop builds, with no legacy fallback or secret disclosure', async t => {
  const f=fixture(t); f.write('content/guide-store.json',f.pin);
  let fetched=0;
  await assert.rejects(loadBuildContent(f.root,appCommit,{env:{...f.env,GUIDE_STORE_REPOSITORY_ID:'52'},fetchStore:async()=>{fetched++;}}),/binding/);
  assert.equal(fetched,0);
  await assert.rejects(loadBuildContent(f.root,appCommit,{env:f.env,fetchStore:async()=>{throw Error('secret-token-sentinel');}}),e=>!e.message.includes('secret-token-sentinel')&&/stopped/.test(e.message));
});
test('no pin retains the original legacy path without remote requests', async t => {
  const f=fixture(t);
  const built=await loadBuildContent(f.root,appCommit,{fetchStore:async()=>{throw Error('must not fetch');}});
  assert.deepEqual(built.release,{commit:appCommit,guides:{}});
});
