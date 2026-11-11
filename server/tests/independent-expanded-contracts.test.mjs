import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request } from './harness.mjs';
import { loadSeedDocuments } from '../manage.mjs';
import { createHandler } from '../http.mjs';
import { createService } from '../service.mjs';
import { createJobRunner } from '../jobs.mjs';
import { PublicationError } from '../github.mjs';
import { documentHash, HOSTED_DOCUMENT_LIMIT_BYTES } from '../core.mjs';
import { validateDocument, renderDocument, escapeHtml } from '../../editor/shared/model.mjs';

const leaves = node => node.type === 'text' ? [node] : node.children.flatMap(leaves);
const elements = node => node.type === 'text' ? [] : [node, ...node.children.flatMap(elements)];
const guideId = 'arch-glacor-basic';

test('independent: widened rich text edits stay inert and cannot alter source, attributes, structure or edit permissions', async () => {
  const catalog = await loadSeedDocuments();
  assert.equal(catalog.length, 323);
  const attack = '<script>window.audit = 1</script><img src=x onerror=alert(1)> & $1 $&';
  let richGuides = 0;
  for (const { document: baseline } of catalog) {
    const index = baseline.blocks.findIndex(block => block.type === 'preserved' && block.editable);
    if (index < 0) continue;
    richGuides++;
    const edited = structuredClone(baseline);
    const block = edited.blocks[index];
    const leaf = leaves(block.node).find(node => block.editableTextNodeIds.includes(node.id));
    assert.ok(leaf, baseline.id);
    leaf.text = attack;
    assert.equal(validateDocument(edited, { baseline }).valid, true, baseline.id);
    const rendered = renderDocument(edited, { baseline });
    assert.ok(rendered.includes(escapeHtml(attack)), baseline.id);
    assert.ok(!rendered.includes(attack), baseline.id);
    const reject = mutate => {
      const tampered = structuredClone(edited);
      mutate(tampered, tampered.blocks[index]);
      assert.equal(validateDocument(tampered, { baseline }).valid, false, baseline.id);
    };
    reject(document => { document.source.url = 'https://attacker.example/'; });
    reject((_, target) => { target.node.attrs.title = 'Changed immutable metadata'; });
    reject((_, target) => { target.node.children.reverse(); target.node.children.push(structuredClone(target.node.children[0])); });
    reject((_, target) => { target.editableTextNodeIds = []; });
    reject((_, target) => { target.node = { id: target.node.id, type: 'text', text: attack }; });
    const readonly = baseline.blocks.findIndex(candidate => leaves(candidate.node).some(node => !candidate.editableTextNodeIds.includes(node.id)));
    if (readonly >= 0) reject(document => {
      const target = document.blocks[readonly];
      leaves(target.node).find(node => !target.editableTextNodeIds.includes(node.id)).text = 'Previously protected text';
    });
    const link = elements(block.node).find(node => node.attrs.href);
    if (link) reject((_, target) => { elements(target.node).find(node => node.id === link.id).attrs.href = 'javascript:alert(1)'; });
  }
  assert.ok(richGuides > 200, 'Exercise the newly imported rich guides, not only the original pilot');
});

function sizedDocument(baseline, bytes) {
  const document = structuredClone(baseline);
  let remaining = bytes - Buffer.byteLength(JSON.stringify(document));
  for (const block of document.blocks) {
    for (const leaf of leaves(block.node)) {
      if (!block.editableTextNodeIds.includes(leaf.id)) continue;
      const count = Math.min(Math.floor((100000 - leaf.text.length) / 2), Math.floor(remaining / 4));
      leaf.text += '💥'.repeat(count); remaining -= count * 4;
      const ascii = Math.min(100000 - leaf.text.length, remaining);
      leaf.text += 'x'.repeat(ascii); remaining -= ascii;
      if (!remaining) break;
    }
    if (!remaining) break;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(document)), bytes);
  assert.equal(validateDocument(document, { baseline }).valid, true);
  return document;
}

test('independent: UTF-8 document cap keeps full snapshot plus baseline responses bounded and draft lists metadata-only', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const owner = await f.user(), other = await f.user();
  const baseline = sizedDocument(f.guide, HOSTED_DOCUMENT_LIMIT_BYTES);
  await f.db.query('INSERT INTO guide_revisions(guide_id,revision,document,content_hash) VALUES($1,2,$2,$3)', [guideId, JSON.stringify(baseline), documentHash(baseline)]);
  await f.db.query('UPDATE guides SET revision=2 WHERE id=$1', [guideId]);
  const edited = structuredClone(baseline);
  edited.title = `${edited.title.slice(0, -1)}!`;
  const handler = createHandler({ db: f.db, config: f.config });
  const save = await handler(request(`drafts/${guideId}`, { user: owner, method: 'PUT', body: { expectedVersion: 0, baseRevision: 2, document: edited } }));
  assert.equal(save.status, 200);
  const saveText = await save.text();
  assert.ok(Buffer.byteLength(saveText) < 4_500_000);
  assert.deepEqual(JSON.parse(saveText).draft.document, edited);
  const tooLarge = structuredClone(edited); tooLarge.title += '💥';
  const denied = await handler(request(`drafts/${guideId}`, { user: owner, method: 'PUT', body: { expectedVersion: 1, baseRevision: 2, document: tooLarge } }));
  assert.equal(denied.status, 422); assert.equal((await denied.json()).error.code, 'document_too_large');
  const listing = await handler(request('drafts', { user: owner }));
  const listText = await listing.text();
  assert.ok(Buffer.byteLength(listText) < 1000);
  const list = JSON.parse(listText).drafts;
  assert.equal(list.length, 1); assert.equal(list[0].version, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['baseRevision', 'guideId', 'savedAt', 'title', 'version']);
  assert.deepEqual((await (await handler(request('drafts', { user: other }))).json()).drafts, []);
  const submit = await handler(request(`drafts/${guideId}/submit`, { user: owner, method: 'POST', body: { expectedVersion: 1, summary: 'Bounded snapshot' } }));
  assert.equal(submit.status, 200);
  const snapshot = await submit.text();
  assert.ok(Buffer.byteLength(snapshot) < 4_500_000);
  const id = JSON.parse(snapshot).submission.id;
  const detail = await handler(request(`submissions/${id}`, { user: owner }));
  assert.equal(detail.status, 200); assert.ok(Buffer.byteLength(await detail.text()) < 4_500_000);
});

async function blockedFixture() {
  const f = await fixture();
  const author = await f.user(), reviewer = await f.user('moderator'), other = await f.user(), admin = await f.user('admin');
  const service = createService(f.db, { publicationEnabled: true, repository: f.config.github });
  await service.saveDraft(author.id, guideId, { expectedVersion: 0, baseRevision: 1, document: f.changed('Approved original') });
  const original = await service.submit(author.id, guideId, { expectedVersion: 1, summary: 'Original snapshot' });
  await service.review(reviewer.id, original.id, { expectedVersion: 1, decision: 'approve' });
  let providerCalls = 0;
  const jobs = createJobRunner(f.db, {
    ensurePullRequest: async () => { providerCalls++; return { number: 19, branchSha: 'a'.repeat(40) }; },
    reconcile: async () => { providerCalls++; throw new PublicationError('branch_conflict', 'Untrusted provider details'); },
  }, { origin: f.config.origin });
  assert.equal((await jobs.runOne()).state, 'blocked');
  return { ...f, author, reviewer, other, admin, service, jobs, original: await service.getSubmission(author.id, original.id), calls: () => providerCalls };
}

test('independent: conflict replacement is owner-scoped, immutable, single-use and cannot reuse prior approval', async t => {
  const f = await blockedFixture(); t.after(() => f.db.close());
  const originalRow = (await f.db.query('SELECT * FROM submissions WHERE id=$1', [f.original.id])).rows[0];
  const input = { expectedVersion: f.original.version, expectedDraftVersion: 1, summary: 'Corrected wording' };
  const handler = createHandler({ db: f.db, config: f.config, publisher: {} });
  const foreign = await handler(request(`submissions/${f.original.id}/resubmit`, { user: f.other, method: 'POST', body: input }));
  assert.equal(foreign.status, 404);
  const wrongCsrf = await handler(request(`submissions/${f.original.id}/resubmit`, { user: f.author, method: 'POST', headers: { 'X-CSRF-Token': f.other.csrf }, body: input }));
  assert.equal(wrongCsrf.status, 403);
  const replacement = await f.service.resubmit(f.author.id, f.original.id, input);
  assert.equal(replacement.status, 'submitted'); assert.equal(replacement.draftVersion, 2);
  assert.equal((await f.service.resubmit(f.author.id, f.original.id, input)).id, replacement.id);
  await assert.rejects(f.service.resubmit(f.admin.id, f.original.id, input), error => error.code === 'already_resubmitted');
  assert.equal(Number((await f.db.query('SELECT count(*) FROM submissions')).rows[0].count), 2);
  assert.equal(Number((await f.db.query('SELECT count(*) FROM publication_jobs WHERE submission_id=$1', [replacement.id])).rows[0].count), 0);
  const before = f.calls();
  await f.jobs.wake();
  assert.equal((await f.jobs.runOne({ submissionId: f.original.id })).state, 'idle');
  assert.equal((await f.jobs.runOne({ submissionId: replacement.id })).state, 'idle');
  assert.equal(f.calls(), before);
  await assert.rejects(f.jobs.retry(f.admin.id, f.original.id), error => error.code === 'publication_superseded');
  await assert.rejects(f.service.review(f.author.id, replacement.id, { expectedVersion: 1, decision: 'approve' }), error => error.code === 'forbidden');
  await assert.rejects(f.service.review(f.reviewer.id, replacement.id, { expectedVersion: f.original.version, decision: 'approve' }), error => error.code === 'review_conflict');
  assert.deepEqual((await f.db.query('SELECT * FROM submissions WHERE id=$1', [f.original.id])).rows[0], originalRow);
  const freshRow = (await f.db.query('SELECT * FROM submissions WHERE id=$1', [replacement.id])).rows[0];
  assert.equal(freshRow.reviewer_id, null); assert.equal(freshRow.reviewed_at, null); assert.equal(freshRow.owner_id, f.author.id);
});

test('independent: configured private review URL is reviewer-only even after demotion, and raw provider URLs are never forwarded', async t => {
  const f = await blockedFixture(); t.after(() => f.db.close());
  await f.db.query('UPDATE publication_jobs SET provider=provider || $2::jsonb WHERE submission_id=$1', [f.original.id, JSON.stringify({ url: 'https://attacker.example/private-secret', html_url: 'javascript:alert(1)' })]);
  const handler = createHandler({ db: f.db, config: f.config, publisher: {} });
  const read = async user => {
    const response = await handler(request(`submissions/${f.original.id}`, { user }));
    const text = await response.text();
    assert.ok(!text.includes('attacker.example')); assert.ok(!text.includes('javascript:'));
    return { status: response.status, body: JSON.parse(text) };
  };
  const author = await read(f.author);
  assert.equal(author.status, 200); assert.equal(Object.hasOwn(author.body.submission.publication, 'reviewUrl'), false);
  assert.equal(Object.hasOwn(author.body.submission.publication, 'errorCode'), false);
  const reviewer = await read(f.reviewer);
  assert.equal(reviewer.status, 200); assert.equal(reviewer.body.submission.publication.reviewUrl, 'https://github.com/example/private-guides/pull/19');
  await f.db.query("UPDATE users SET role='contributor' WHERE id=$1", [f.reviewer.id]);
  assert.equal((await read(f.reviewer)).status, 404, 'Authorization must use the current role, not the login-time role');
  assert.equal((await read(f.other)).status, 404);
});
