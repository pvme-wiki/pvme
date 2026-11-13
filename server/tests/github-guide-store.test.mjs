import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { migrate, seed } from '../manage.mjs';
import { createService } from '../service.mjs';
import { createJobRunner } from '../jobs.mjs';
import { createPinController, handoffGuidePublication } from '../publication-targets.mjs';
import { verifyPublicationGate } from '../publication-gate.mjs';
import { loadHostedContent } from '../../scripts/hosted-content.mjs';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createGitHubGuideStore, verifyGuideReleaseSource, guideContentBranch } from '../github-guide-store.mjs';
import { createGuideGitHubClients, guideGitBlobSha } from '../guide-github-transport.mjs';
import { documentHash } from '../core.mjs';
import { approvedFiles } from '../github.mjs';
import { publicationProofId } from '../publication-proof.mjs';
import { serializeGuideFile, guideStoreSha256, GUIDE_STORE_DOCUMENTATION, updateGuideManifest, validateGuideStore } from '../content-store.mjs';
const baseline = JSON.parse(await readFile(new URL('../../editor/content/arch-glacor-basic.json', import.meta.url)));
const secondGuide = JSON.parse(await readFile(new URL('../../editor/content/helwyr.json', import.meta.url)));
const digest = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');
const config = { origin: 'guides-v1', pinPath: 'content/guide-store.json', content: { id: 100, owner: 'guide-org', repo: 'private-guides', base: 'main', installationId: '10' }, app: { id: 200, owner: 'owner', repo: 'app', base: 'main', installationId: '20' } };
function repoFake(settings, ownerType) {
  const commits = new Map(), refs = new Map(), pulls = [], writes = [];
  let salt = 0;
  const client = {
    repository: { id: settings.id, owner: settings.owner, repo: settings.repo, base: settings.base }, commits, refs, pullsList: pulls, writes,
    async privateRepo(expected) { assert.equal(expected.ownerType, ownerType); return { private: true, id: settings.id }; },
    addCommit(files, parents = []) {
      const copy = new Map([...files].map(([path, bytes]) => [path, Buffer.from(bytes)]));
      const sha = digest({ files: [...copy].map(([path, bytes]) => [path, guideGitBlobSha(bytes)]), parents, salt: salt++ });
      commits.set(sha, { sha, tree: { sha: digest([...copy.keys()]) }, parents: parents.map(sha => ({ sha })), files: copy }); return sha;
    },
    async commit(sha) { assert.ok(commits.has(sha), 'expected known commit ' + sha); return commits.get(sha); },
    async filesAt(sha) { return new Map([...(await client.commit(sha)).files].map(([path, bytes]) => [path, { path, type: 'blob', mode: '100644', sha: guideGitBlobSha(bytes), size: bytes.length }])); },
    async bytesAt(sha, path, { optional = false } = {}) { const bytes = (await client.commit(sha)).files.get(path); if (!bytes && !optional) throw Error('missing ' + path); return bytes || null; },
    async jsonAt(sha, path, options) { const bytes = await client.bytesAt(sha, path, options); return bytes ? JSON.parse(bytes) : null; },
    async ref(branch = settings.base) { return refs.get(branch) || null; },
    async isDescendant(base, head) { return base === head || Boolean(commits.get(head)?.parents.some(parent => client.isAncestor(base, parent.sha))); },
    isAncestor(base, head) { return base === head || Boolean(commits.get(head)?.parents.some(parent => client.isAncestor(base, parent.sha))); },
    async pull(number) { assert.ok(pulls[number - 1]); return pulls[number - 1]; },
    async pulls(branch) { return pulls.filter(pull => pull.head.ref === branch); },
    async createBranch(branch, base, files, message) {
      writes.push({ kind: 'branch', branch, files: [...files], message });
      const next = new Map(commits.get(base).files); for (const [path, bytes] of files) next.set(path, bytes);
      const sha = client.addCommit(next, [base]); refs.set(branch, sha); return sha;
    },
    async createPull(branch, title, body) {
      const repository = { id: settings.id, full_name: `${settings.owner}/${settings.repo}` };
      const pull = { number: pulls.length + 1, state: 'open', merged: false, head: { sha: refs.get(branch), ref: branch, repo: repository }, base: { ref: settings.base, repo: repository } };
      pulls.push(pull); writes.push({ kind: 'pull', title, body }); return pull;
    },
    merge(number = 1, login = config.app.owner) {
      const pull = pulls[number - 1], main = refs.get(settings.base), head = commits.get(pull.head.sha);
      const files = new Map(commits.get(main).files);
      const parent = commits.get(head.parents[0].sha).files;
      for (const [path, bytes] of head.files) if (!parent.has(path) || !parent.get(path).equals(bytes)) files.set(path, bytes);
      const merge = client.addCommit(files, [main, head.sha]);
      Object.assign(pull, { merged: true, state: 'closed', merge_commit_sha: merge, merged_by: { login } }); refs.set(settings.base, merge); return merge;
    },
    advance(changes = new Map()) {
      const parent = refs.get(settings.base), files = new Map(commits.get(parent).files);
      for (const [path, value] of changes) files.set(path, Buffer.isBuffer(value) ? value : serializeGuideFile(value));
      const sha = client.addCommit(files, [parent]); refs.set(settings.base, sha); return sha;
    },
  };
  return client;
}
function fixture({ mode = 'active', allowActivation = false, inactive = false, second = false } = {}) {
  const id = baseline.id, expectedBaselines = new Map([[id, baseline]]), catalog = [{ id, file: `${id}.json` }], expectedCatalogBytes = serializeGuideFile(catalog), baselineBytes = serializeGuideFile(baseline);
  const secondBaseline = structuredClone(secondGuide);
  if (inactive || second) { expectedBaselines.set(secondBaseline.id, secondBaseline); catalog.push({ id: secondBaseline.id, file: `${secondBaseline.id}.json` }); }
  const catalogBytes = serializeGuideFile(catalog);
  const manifest = { schemaVersion: 1, origin: 'guides-v1', catalog: { path: 'baselines/catalog.json', sha256: guideStoreSha256(catalogBytes) }, baselines: { [id]: { path: `baselines/${id}.json`, sha256: guideStoreSha256(baselineBytes), contentHash: documentHash(baseline) } }, guides: {} };
  const seedGuide = { ...structuredClone(secondBaseline), title: 'Earlier inactive seed' };
  if (inactive || second) {
    const bytes = serializeGuideFile(secondBaseline);
    manifest.baselines[secondBaseline.id] = { path: `baselines/${secondBaseline.id}.json`, sha256: guideStoreSha256(bytes), contentHash: documentHash(secondBaseline) };
    if (inactive) manifest.guides[secondBaseline.id] = { path: `guides/${secondBaseline.id}.json`, sha256: guideStoreSha256(serializeGuideFile(seedGuide)), contentHash: documentHash(seedGuide), baselineHash: documentHash(secondBaseline), revision: 2 };
  }
  const manifestBytes = serializeGuideFile(manifest);
  const content = repoFake(config.content, 'Organization'), app = repoFake(config.app, 'User'), clients = { content, app };
  const contentFiles = new Map([...GUIDE_STORE_DOCUMENTATION, ['manifest.json', manifestBytes], ['baselines/catalog.json', catalogBytes], [`baselines/${id}.json`, baselineBytes]]);
  if (inactive || second) contentFiles.set(`baselines/${secondBaseline.id}.json`, serializeGuideFile(secondBaseline));
  if (inactive) contentFiles.set(`guides/${secondBaseline.id}.json`, serializeGuideFile(seedGuide));
  const initialContent = content.addCommit(contentFiles);
  content.refs.set('main', initialContent);
  const pin = { schemaVersion: 1, mode, origin: 'guides-v1', repository: content.repository, contentCommit: initialContent, manifestSha256: guideStoreSha256(manifestBytes), guideIds: [] };
  const appFiles = new Map([['editor/content/catalog.json', catalogBytes], [config.pinPath, serializeGuideFile(pin)], [`editor/content/${id}.json`, baselineBytes], ['README.md', Buffer.from('Application')]]);
  if (inactive) { appFiles.set(`content/guides/${secondBaseline.id}.json`, serializeGuideFile({ ...secondBaseline, title: 'Newer independently published legacy guide' })); appFiles.set('content/reviews/private-legacy-history.json', Buffer.from('{"private":"existing receipt history"}')); }
  const initialApp = app.addCommit(appFiles); app.refs.set('main', initialApp);
  const document = { ...structuredClone(baseline), title: baseline.title + ' reviewed' };
  const row = { id: randomUUID(), guide_id: id, status: 'publishing', owner_id: randomUUID(), reviewer_id: randomUUID(), base_revision: 1, draft_version: 1, baseline_document: baseline, baseline_hash: documentHash(baseline), document, content_hash: documentHash(document), summary: 'Clear wording', review_note: 'Reviewed', created_at: '2026-11-13T12:00:00Z', reviewed_at: '2026-11-13T13:00:00Z', publication_target: { pipeline: 'content-pin-v1', origin: 'guides-v1', repository: { ...content.repository, id: String(content.repository.id) }, installationId: '10' } };
  const rows = [row]; let release = null, leased = false;
  let state = { origin: config.origin, version: 0, contentCommit: null, appCommit: null, provider: {} };
  const pinController = { async withLease(origin, callback) {
    if (leased) throw Error('lease busy'); leased = true;
    try { return await callback({ read: async () => structuredClone(state), checkpoint: async input => {
      assert.equal(input.expectedVersion, state.version);
      if (state.contentCommit && state.contentCommit !== input.contentCommit) assert.equal(await input.isDescendant(state.contentCommit, input.contentCommit), true);
      state = { ...state, ...input, version: state.version + 1 }; delete state.isDescendant; delete state.expectedVersion; return structuredClone(state);
    } }); } finally { leased = false; }
  } };
  const options = { clients, expectedBaselines, expectedCatalogBytes: catalogBytes, pinController, approvalRows: async () => rows, allowActivation, fetchImpl: async () => release ? new Response(JSON.stringify(release)) : new Response('', { status: 404 }) };
  const provider = createGitHubGuideStore(config, options);
  let info;
  return { row, rows, clients, app, content, pin, initialContent, initialApp, options, provider, secondBaseline, seedGuide,
    async ensure() { info = await provider.ensurePullRequest(row); row.job_provider = info; return info; },
    async check() { const result = await provider.reconcile(row, info, 'https://pvme.example'); info = result.provider; row.job_provider = info; return result; },
    release(value) { release = value; },
    async validRelease() {
      const appCommit = await app.ref(), actualPin = await app.jsonAt(appCommit, config.pinPath);
      return { schemaVersion: 2, commit: appCommit, appCommit, contentCommit: actualPin.contentCommit, contentOrigin: 'guides-v1', guides: { [id]: { proofId: publicationProofId(approvedFiles(row)[`content/reviews/${row.id}.json`]), contentHash: row.content_hash } } };
    },
    get info() { return info; }, get state() { return state; },
  };
}

test('content merge creates owner-reviewed app pin and full private receipt; only matching live A/C proof publishes', async () => {
  const f = fixture(); const first = await f.ensure();
  assert.equal(first.phase, 'content_review'); assert.equal(first.merged, false);
  assert.equal((await f.check()).state, 'awaiting_merge');
  const orgWrites = JSON.stringify(f.content.writes);
  assert.equal(orgWrites.includes(f.row.id), false); assert.equal(orgWrites.includes(f.row.owner_id), false);
  assert.deepEqual(f.content.writes[0].files.map(([path]) => path).sort(), [`guides/${f.row.guide_id}.json`, 'manifest.json'].sort());
  const contentMerge = f.content.merge();
  const pending = await f.check();
  assert.equal(pending.provider.phase, 'website_update'); assert.equal(pending.provider.merged, false); assert.equal(pending.provider.contentMergeSha, contentMerge);
  const appFiles = f.app.writes[0].files.map(([path]) => path).sort();
  assert.deepEqual(appFiles, [config.pinPath, `content/reviews/${f.row.id}.json`].sort());
  const appMerge = f.app.merge();
  const deployed = await f.check();
  assert.equal(deployed.state, 'awaiting_deployment'); assert.equal(deployed.provider.appMergeSha, appMerge); assert.equal(deployed.provider.merged, true);
  const release = await f.validRelease();
  f.release({ ...release, contentCommit: f.initialContent }); assert.equal((await f.check()).state, 'awaiting_deployment');
  f.release({ ...release, guides: { [f.row.guide_id]: { submissionId: f.row.id, contentHash: f.row.content_hash } } }); assert.equal((await f.check()).state, 'awaiting_deployment');
  f.release(release); const live = await f.check();
  assert.equal(live.state, 'published'); assert.equal(live.provider.phase, 'live'); assert.equal(live.provider.deployedCommit, appMerge);
});
test('shadow is inert by default; explicit handoff enables a real approved first content and owner pin review', async () => {
  const blocked = fixture({ mode: 'shadow' });
  await assert.rejects(blocked.ensure(), error => error.code === 'publication_unconfigured');
  assert.equal(blocked.content.writes.length, 0);
  const f = fixture({ mode: 'shadow', allowActivation: true });
  await f.ensure(); f.content.merge(); await f.check();
  const pin = await f.app.jsonAt(f.info.pin.branchSha, config.pinPath);
  assert.equal(pin.mode, 'active'); assert.deepEqual(pin.guideIds, [f.row.guide_id]);
  f.app.merge(); await f.check(); f.release(await f.validRelease()); assert.equal((await f.check()).state, 'published');
});
test('wrong frozen target, extra content files, changed baseline and unowned app merges fail closed', async () => {
  const wrong = fixture(); wrong.row.publication_target.repository.id = '999';
  await assert.rejects(wrong.ensure(), error => error.code === 'publication_target_mismatch');
  const tampered = fixture(); await tampered.ensure();
  const original = tampered.content.commits.get(tampered.info.branchSha), files = new Map(original.files); files.set('secret.json', Buffer.from('{}'));
  const newHead = tampered.content.addCommit(files, original.parents.map(parent => parent.sha));
  tampered.content.refs.set(guideContentBranch(tampered.row), newHead); tampered.content.pullsList[0].head.sha = newHead;
  await assert.rejects(tampered.ensure(), error => error.code === 'branch_conflict');
  const changed = fixture(); changed.content.advance(new Map([[`baselines/${changed.row.guide_id}.json`, { ...baseline, title: 'Tampered' }]]));
  await assert.rejects(changed.ensure(), error => error.code === 'baseline_mismatch');
  const owner = fixture(); await owner.ensure(); owner.content.merge(); await owner.check(); owner.app.merge(1, 'someone-else');
  await assert.rejects(owner.check(), error => error.code === 'owner_merge_required');
});
test('lost acknowledgement and deleted merged branches recover deterministic reviews without duplicate PRs', async () => {
  const f = fixture(); await f.ensure();
  assert.equal((await f.provider.ensurePullRequest(f.row)).number, 1);
  f.content.merge(); f.content.refs.delete(f.info.branch);
  assert.equal((await f.provider.ensurePullRequest(f.row)).number, 1);
  await f.check(); const pending = structuredClone(f.info);
  f.app.merge(); f.app.refs.delete(pending.pin.branch);
  const retry = await f.provider.reconcile(f.row, pending, 'https://pvme.example');
  assert.equal(retry.state, 'awaiting_deployment'); assert.equal(f.app.pullsList.length, 1); assert.equal(f.content.pullsList.length, 1);
});
test('release proof rejects unmerged app reviews, source substitution and same-hash divergent pins', async () => {
  const f = fixture(); await f.ensure(); f.content.merge(); await f.check();
  const pin = await f.app.jsonAt(f.info.pin.branchSha, config.pinPath);
  const inputs = { pin, appCommit: f.info.pin.branchSha, rows: f.rows, config, ...f.options };
  await assert.rejects(verifyGuideReleaseSource(inputs), error => error.code === 'publication_proof_mismatch');
  f.app.merge(); await f.check(); inputs.appCommit = await f.app.ref();
  assert.equal((await verifyGuideReleaseSource(inputs)).contentCommit, pin.contentCommit);
  const divergent = f.content.addCommit(new Map(f.content.commits.get(pin.contentCommit).files));
  const validApp = await f.app.ref(), forgedPin = { ...pin, contentCommit: divergent };
  const forgedApp = f.app.advance(new Map([[config.pinPath, serializeGuideFile(forgedPin)]]));
  await assert.rejects(verifyGuideReleaseSource({ ...inputs, appCommit: forgedApp, pin: forgedPin }), error => error.code === 'publication_proof_mismatch');
  f.app.refs.set('main', validApp);
  const old = f.row.job_provider.content.mergeSha; f.row.job_provider.content.mergeSha = 'f'.repeat(40);
  await assert.rejects(verifyGuideReleaseSource(inputs), error => error.code === 'merge_conflict'); f.row.job_provider.content.mergeSha = old;
});
test('read-only transport uses exact repository tokens and refuses every mutation', async () => {
  const tokens = [], calls = [];
  const clients = createGuideGitHubClients(config, { readOnly: true, getToken: async input => { tokens.push(input); return `token-${input.repository.id}`; }, fetchImpl: async (url, options) => {
    calls.push({ url, options }); const content = url.includes('/guide-org/');
    return new Response(JSON.stringify({ id: content ? 100 : 200, private: true, full_name: content ? 'guide-org/private-guides' : 'owner/app', owner: { type: content ? 'Organization' : 'User' } }));
  } });
  await clients.content.privateRepo({ ownerType: 'Organization' }); await clients.app.privateRepo({ ownerType: 'User' });
  assert.deepEqual(tokens.map(value => value.repository.id), [100, 200]);
  assert.ok(tokens.every(value => value.permissions.contents === 'read' && value.permissions.pull_requests === 'read'));
  await assert.rejects(clients.content.createPull('branch', 'title', 'body'), error => error.code === 'read_only_publication_proof');
  assert.equal(calls.length, 2); assert.ok(calls.every(value => value.options.method === 'GET'));
});

test('inactive seeded legacy guides may evolve in the app without being claimed or rewritten by a partial handoff', async () => {
  const f = fixture({ inactive: true }); await f.ensure(); f.content.merge(); await f.check();
  assert.deepEqual((await f.app.jsonAt(f.info.pin.branchSha, config.pinPath)).guideIds, [f.row.guide_id]);
  assert.deepEqual(f.app.writes[0].files.map(([path]) => path).sort(), [config.pinPath, `content/reviews/${f.row.id}.json`].sort());
  f.app.merge(); await f.check();
  const actual = await f.app.jsonAt(await f.app.ref(), `content/guides/${f.secondBaseline.id}.json`);
  assert.equal(actual.title, 'Newer independently published legacy guide');
  assert.equal((await f.content.jsonAt(await f.content.ref(), `guides/${f.secondBaseline.id}.json`)).title, 'Earlier inactive seed');
  f.release(await f.validRelease()); assert.equal((await f.check()).state, 'published');
  const pin = await f.app.jsonAt(await f.app.ref(), config.pinPath);
  assert.equal((await verifyGuideReleaseSource({ pin, appCommit: await f.app.ref(), rows: [f.row], config, ...f.options })).contentCommit, pin.contentCommit);
});
test('a changed inactive content guide cannot ride along without a frozen approval and merged review', async () => {
  const f = fixture({ inactive: true }); await f.ensure(); f.content.merge();
  const current = await f.content.jsonAt(await f.content.ref(), 'manifest.json');
  const updated = updateGuideManifest(current, { guideId: f.secondBaseline.id, document: { ...f.seedGuide, title: 'Unapproved change' }, baselineHash: documentHash(f.seedGuide), revision: 3 }, f.options);
  f.content.advance(new Map([['manifest.json', updated.manifestBytes], [`guides/${f.secondBaseline.id}.json`, updated.guideBytes]]));
  await assert.rejects(f.check(), error => error.code === 'approval_not_verified');
  assert.equal(f.app.writes.length, 0);
});
test('concurrent guide merges aggregate every active approval into one deterministic owner pin review', async () => {
  const f = fixture({ second: true }); await f.ensure(); f.content.merge();
  const secondDocument = { ...structuredClone(f.secondBaseline), title: 'Second reviewed guide' };
  const second = { ...f.row, id: randomUUID(), guide_id: f.secondBaseline.id, document: secondDocument, baseline_document: f.secondBaseline, content_hash: documentHash(secondDocument), baseline_hash: documentHash(f.secondBaseline) };
  f.rows.push(second);
  let secondInfo = await f.provider.ensurePullRequest(second); second.job_provider = secondInfo;
  f.content.merge(secondInfo.number);
  await f.check(); const sharedPin = structuredClone(f.info.pin);
  const secondPending = await f.provider.reconcile(second, secondInfo, 'https://pvme.example'); secondInfo = secondPending.provider; second.job_provider = secondInfo;
  assert.equal(secondInfo.websiteNumber, f.info.websiteNumber); assert.equal(f.app.pullsList.length, 1);
  const reviewFiles = f.app.writes[0].files.map(([path]) => path).sort();
  assert.deepEqual(reviewFiles, [config.pinPath, `content/reviews/${f.row.id}.json`, `content/reviews/${second.id}.json`].sort());
  f.app.merge(); await f.check();
  const secondMerged = await f.provider.reconcile(second, secondInfo, 'https://pvme.example'); second.job_provider = secondMerged.provider;
  assert.equal(secondMerged.provider.merged, true); assert.equal(secondMerged.provider.contentCommit, sharedPin.contentCommit);
  const pin = await f.app.jsonAt(await f.app.ref(), config.pinPath);
  assert.deepEqual(pin.guideIds, f.rows.map(row => row.guide_id).sort());
  assert.equal((await verifyGuideReleaseSource({ pin, appCommit: await f.app.ref(), rows: f.rows, config, ...f.options })).contentCommit, pin.contentCommit);
});

test('durable pin intent recovers a lost app PR acknowledgement even when content main advances', async () => {
  const f = fixture(); await f.ensure(); const contentMerge = f.content.merge();
  const createPull = f.app.createPull; let lose = true;
  f.app.createPull = async (...args) => { const pull = await createPull(...args); if (lose) { lose = false; throw Error('Lost acknowledgement after GitHub created PR'); } return pull; };
  await assert.rejects(f.check(), /Lost acknowledgement/);
  assert.equal(f.state.provider.pinIntent.contentCommit, contentMerge);
  assert.equal(f.app.pullsList.length, 1);
  const newer = f.content.advance(); assert.notEqual(newer, contentMerge);
  const recovered = await f.check();
  assert.equal(recovered.provider.contentCommit, contentMerge); assert.equal(recovered.provider.websiteNumber, 1);
  assert.equal(f.app.pullsList.length, 1); assert.equal(f.app.writes.filter(write => write.kind === 'branch').length, 1);
});

// Mock GitHub repositories + real PGlite migrations/service/jobs/loader/gate.
// This exercises contracts together; it is not a live GitHub or Vercel rollout.
test('joined approval database → split provider → private loader → production gate → live A/C proof', async t => {
  const pg = new PGlite(); t.after(() => pg.close());
  const db = { query: (sql, params = []) => pg.query(sql, params), transaction: work => pg.transaction(q => work({ query: (sql, params = []) => q.query(sql, params), exec: sql => q.exec(sql) })) };
  const f = fixture({ mode: 'shadow', allowActivation: true });
  const legacy = { pipeline: 'legacy-v1', origin: 'legacy-v1', repository: { ...f.app.repository, id: String(f.app.repository.id) }, installationId: config.app.installationId };
  const content = structuredClone(f.row.publication_target), registry = [legacy, { ...content, appRepository: legacy.repository }];
  await migrate(db, { legacyTarget: legacy }); await seed(db, { guideIds: [baseline.id] });
  const owner = randomUUID(), reviewer = randomUUID();
  await db.query("INSERT INTO users(id,discord_id,display_name,role) VALUES($1,'123456789','Contributor','contributor'),($2,'987654321','Reviewer','moderator')", [owner, reviewer]);
  await handoffGuidePublication(db, { guideId: baseline.id, target: content, expectedRevision: 1, expectedHash: documentHash(baseline), contentCommit: f.initialContent, reason: 'Mock operator-reviewed first handoff', verifyContent: async ({ contentCommit, contentHash }) => documentHash(await f.content.jsonAt(contentCommit, `baselines/${baseline.id}.json`)) === contentHash });
  const service = createService(db, { publicationEnabled: true, publicationTargets: registry, defaultPublicationTarget: legacy });
  await service.saveDraft(owner, baseline.id, { document: f.row.document, expectedVersion: 0, baseRevision: 1 });
  const submission = await service.submit(owner, baseline.id, { expectedVersion: 1, summary: 'Reviewed title for the first active guide' });
  await service.review(reviewer, submission.id, { decision: 'approve', expectedVersion: 1, note: 'Reviewed the exact guide and source provenance' });
  const pinController = createPinController(db);
  const provider = createGitHubGuideStore(config, { ...f.options, pinController, approvalRows: ids => pinController.approvals(ids) });
  const jobs = createJobRunner(db, { resolve: async target => ({ target, provider }) }, { origin: 'https://pvme.example', publicationTargets: registry });
  const run = async () => { await jobs.wake(); return jobs.runOne({ submissionId: submission.id }); };
  assert.equal((await run()).state, 'awaiting_merge');
  assert.equal((await service.getGuide(baseline.id)).revision, 1);
  const contentMerge = f.content.merge();
  assert.equal((await run()).state, 'awaiting_merge');
  assert.equal((await service.getGuide(baseline.id)).revision, 1, 'content merge does not advance canonical editing baseline');
  const pending = (await db.query('SELECT provider FROM publication_jobs WHERE submission_id=$1', [submission.id])).rows[0].provider;
  assert.equal(pending.phase, 'website_update'); assert.equal(pending.contentMergeSha, contentMerge); assert.equal(pending.merged, false);
  const appMerge = f.app.merge();
  const pin = await f.app.jsonAt(appMerge, config.pinPath);
  const guideStore = validateGuideStore({ pin, manifestBytes: await f.content.bytesAt(pin.contentCommit, 'manifest.json'), files: f.content.commits.get(pin.contentCommit).files, expectedBaselines: f.options.expectedBaselines, expectedCatalogBytes: f.options.expectedCatalogBytes, expectedRepository: f.content.repository });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvme-split-publication-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [filename, bytes] of f.app.commits.get(appMerge).files) { const file = path.join(root, filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  const built = loadHostedContent(root, appMerge, { guideStore });
  const verified = await verifyPublicationGate(db, built.published, { expectedBaselines: f.options.expectedBaselines, guideStore, appCommit: appMerge, verifySource: proof => verifyGuideReleaseSource({ ...proof, config, clients: f.clients, expectedBaselines: f.options.expectedBaselines, expectedCatalogBytes: f.options.expectedCatalogBytes }) });
  assert.equal(verified.verifiedCount, 1);
  assert.equal(built.release.schemaVersion, 2); assert.equal(built.release.contentCommit, contentMerge); assert.equal(built.release.appCommit, appMerge);
  assert.equal(JSON.stringify(built.release).includes(submission.id), false);
  assert.equal((await run()).state, 'awaiting_deployment');
  assert.equal((await service.getGuide(baseline.id)).revision, 2, 'only verified owner app-pin merge advances canonical editing baseline');
  assert.equal((await service.getSubmission(owner, submission.id)).status, 'publishing');
  f.release({ ...built.release, contentCommit: f.initialContent });
  assert.equal((await run()).state, 'awaiting_deployment');
  assert.equal((await service.getSubmission(owner, submission.id)).status, 'publishing');
  f.release(built.release);
  assert.equal((await run()).state, 'published');
  assert.equal((await service.getSubmission(owner, submission.id)).status, 'published');
  assert.equal((await service.getGuide(baseline.id)).revision, 2);
});

test('later aggregate pin preserves existing receipt bytes and an earlier job can verify a newer forward release', async () => {
  const f = fixture({ second: true }); await f.ensure(); f.content.merge(); await f.check(); f.app.merge(); await f.check();
  assert.equal(f.state.appCommit, await f.app.ref(), 'observed owner merge is durably recorded');
  const path = `content/reviews/${f.row.id}.json`, originalReceipt = approvedFiles(f.row)[path];
  const unusualBytes = Buffer.from('\n' + JSON.stringify(Object.fromEntries(Object.entries(originalReceipt).reverse()), null, 4) + '\n\n');
  const olderApp = f.app.advance(new Map([[path, unusualBytes]]));
  const originalBlob = (await f.app.filesAt(olderApp)).get(path).sha;
  const document = { ...structuredClone(f.secondBaseline), title: 'Second later approved guide' };
  const second = { ...f.row, id: randomUUID(), guide_id: f.secondBaseline.id, document, baseline_document: f.secondBaseline, content_hash: documentHash(document), baseline_hash: documentHash(f.secondBaseline) };
  f.rows.push(second); let info = await f.provider.ensurePullRequest(second); second.job_provider = info;
  f.content.merge(info.number);
  const pending = await f.provider.reconcile(second, info, 'https://pvme.example'); info = pending.provider; second.job_provider = info;
  const writes = f.app.writes.filter(write => write.kind === 'branch');
  assert.equal(writes.length, 2); assert.equal(writes[1].files.some(([filename]) => filename === path), false, 'historical receipt is absent from planned writes');
  assert.deepEqual(await f.app.bytesAt(info.pin.branchSha, path), unusualBytes);
  assert.equal((await f.app.filesAt(info.pin.branchSha)).get(path).sha, originalBlob);
  f.app.merge(info.websiteNumber);
  const merged = await f.provider.reconcile(second, info, 'https://pvme.example'); second.job_provider = merged.provider;
  assert.deepEqual(await f.app.bytesAt(await f.app.ref(), path), unusualBytes);
  const release = await f.validRelease();
  release.guides[second.guide_id] = { proofId: publicationProofId(approvedFiles(second)[`content/reviews/${second.id}.json`]), contentHash: second.content_hash };
  f.release(release);
  const earlier = await f.check();
  assert.equal(earlier.state, 'published'); assert.equal(earlier.provider.contentCommit, release.contentCommit); assert.equal(earlier.provider.appCommit, release.appCommit);
});

test('the current FIFO approval progresses despite identical queued, blocked, replaced or superseded history', async () => {
  const f = fixture(); await f.ensure(); f.content.merge();
  const queued = { ...structuredClone(f.row), id: randomUUID(), owner_id: randomUUID(), reviewer_id: randomUUID(), job_state: 'queued', job_provider: {} };
  f.rows.push(queued);
  const pending = await f.check();
  assert.equal(pending.provider.phase, 'website_update');
  const receiptFiles = f.app.writes[0].files.map(([path]) => path);
  assert.ok(receiptFiles.includes(`content/reviews/${f.row.id}.json`));
  assert.equal(receiptFiles.includes(`content/reviews/${queued.id}.json`), false);
  for (const history of [
    { job_state: 'blocked' }, { job_provider: { ...structuredClone(f.row.job_provider), replacementId: randomUUID() } }, { superseded: true },
  ]) f.rows.push({ ...structuredClone(f.row), id: randomUUID(), ...history });
  f.app.merge(); await f.check(); f.release(await f.validRelease());
  assert.equal((await f.check()).state, 'published');
  const pin = await f.app.jsonAt(await f.app.ref(), config.pinPath);
  const active = { ...structuredClone(f.row), id: randomUUID(), owner_id: randomUUID(), reviewer_id: randomUUID(), job_state: 'awaiting_merge' };
  await assert.rejects(verifyGuideReleaseSource({ pin, appCommit: await f.app.ref(), rows: [active, f.row], config, ...f.options }), error => error.code === 'approval_not_verified');
});
