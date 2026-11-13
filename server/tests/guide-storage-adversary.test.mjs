import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {fixture as databaseFixture} from './harness.mjs';
import {migrate} from '../manage.mjs';
import {documentHash, canonical} from '../core.mjs';
import {approvedFiles} from '../github.mjs';
import {verifyPublicationGate} from '../publication-gate.mjs';
import {publicationProofId, matchesPublicationProof} from '../publication-proof.mjs';
import {loadHostedContent} from '../../scripts/hosted-content.mjs';
import {validateGuideStore, serializeGuideFile, guideStoreSha256, GUIDE_STORE_DOCUMENTATION} from '../content-store.mjs';
import {trustedPublicationTarget} from '../publication-targets.mjs';

const A = 'a'.repeat(40), C = 'c'.repeat(40), OLD_C = 'b'.repeat(40);
const repository = {id: 202, owner: 'pvme-wiki', repo: 'guides', base: 'main'};
const contentTarget = {pipeline: 'content-pin-v1', origin: 'guides-v1', repository: {...repository, id: '202'}, installationId: '67890'};
const legacyTarget = {pipeline: 'legacy-v1', origin: 'legacy-v1', repository: {id: '101', owner: 'owner', repo: 'app', base: 'main'}, installationId: '12345'};
const baselines = ['arch-glacor-basic', 'helwyr'].map(id => JSON.parse(fs.readFileSync(new URL(`../../editor/content/${id}.json`, import.meta.url))));
function approval(baseline, target = contentTarget) {
  const document = {...structuredClone(baseline), title: baseline.title + ' approved'};
  return {id: randomUUID(), guide_id: baseline.id, document, content_hash: documentHash(document), baseline_document: baseline,
    baseline_hash: documentHash(baseline), base_revision: 1, draft_version: 2, owner_id: randomUUID(), reviewer_id: randomUUID(),
    summary: 'PRIVATE_APPROVAL_SUMMARY_SENTINEL', review_note: 'PRIVATE_REVIEW_NOTE_SENTINEL',
    created_at: '2026-11-13T12:00:00Z', reviewed_at: '2026-11-13T13:00:00Z', status: 'publishing',
    publication_target: structuredClone(target), job_state: 'awaiting_deployment', job_provider: {pipeline: target.pipeline},
    current_revision: 1, current_hash: documentHash(baseline), current_publication_id: null};
}
function gateFixture() {
  const rows = [approval(baselines[0]), approval(baselines[1], legacyTarget)];
  const receipts = rows.map(row => approvedFiles(row)[`content/reviews/${row.id}.json`]);
  const entries = rows.map((row, i) => ({document: row.document, contentHash: row.content_hash, receipt: receipts[i]}));
  const snapshot = {approvals: rows, canonical_guides: rows.map((row, i) => ({guideId: row.guide_id, submissionId: null, revision: 1,
    contentHash: row.baseline_hash, initialHash: row.baseline_hash, publicationTarget: row.publication_target,
    publicationPin: i === 0 ? {contentCommit: C, version: 3} : null}))};
  const pin = {schemaVersion: 1, mode: 'active', origin: 'guides-v1', repository, contentCommit: C, manifestSha256: 'd'.repeat(64), guideIds: [rows[0].guide_id]};
  const guideStore = {pin, guides: new Map([[rows[0].guide_id, {document: rows[0].document, contentHash: rows[0].content_hash, baselineHash: rows[0].baseline_hash, revision: 2}]])};
  const expectedBaselines = new Map(baselines.map(doc => [doc.id, doc]));
  const db = {async query(sql) { assert.match(sql, /^SELECT\s/); return {rows: [snapshot]}; }};
  const proof = async ({appCommit, pin: actual}) => ({appCommit, contentCommit: actual.contentCommit, contentOrigin: actual.origin});
  return {rows, receipts, entries, snapshot, pin, guideStore, db, options: {expectedBaselines, guideStore, appCommit: A, verifySource: proof}};
}
const code = expected => error => {assert.equal(error.code, expected); return true;};

test('independent: production source proof receives exact app commit, pin and ALL active/legacy terminal approvals', async () => {
  const f = gateFixture(); let calls = 0;
  f.options.verifySource = async input => {
    calls++; assert.equal(input.appCommit, A); assert.deepEqual(input.pin, f.pin);
    assert.deepEqual(input.rows.map(row => row.id).sort(), f.rows.map(row => row.id).sort());
    return {appCommit: A, contentCommit: C, contentOrigin: 'guides-v1'};
  };
  assert.equal((await verifyPublicationGate(f.db, f.entries, f.options)).verifiedCount, 2);
  assert.equal(calls, 1);
});

test('independent: a source callback is mandatory and rejected or mismatched source evidence cannot authorize production', async () => {
  for (const evidence of [false, undefined, {appCommit: 'f'.repeat(40), contentCommit: C, contentOrigin: 'guides-v1'}, {appCommit: A, contentCommit: OLD_C, contentOrigin: 'guides-v1'}, {appCommit: A, contentCommit: C, contentOrigin: 'unknown'}]) {
    const f = gateFixture(); f.options.verifySource = async () => evidence;
    await assert.rejects(verifyPublicationGate(f.db, f.entries, f.options), code('publication_source_unavailable'), `Unverified source evidence ${JSON.stringify(evidence)}`);
  }
  const f = gateFixture(); delete f.options.verifySource;
  await assert.rejects(verifyPublicationGate(f.db, f.entries, f.options), code('publication_source_unavailable'));
});

test('independent: same guide hashes cannot authorize an older content commit than the durable pin controller', async () => {
  const f = gateFixture(); f.pin.contentCommit = OLD_C;
  await assert.rejects(verifyPublicationGate(f.db, f.entries, f.options), code('content_pin_not_current'));
  f.pin.contentCommit = C; assert.equal((await verifyPublicationGate(f.db, f.entries, f.options)).verifiedCount, 2);
});

test('independent: authority removal, extra guide takeover and repository substitution fail before source verification', async () => {
  for (const mutate of [f => f.pin.guideIds = [], f => f.pin.guideIds = f.rows.map(row => row.guide_id).sort(), f => f.pin.repository = {...repository, id: 999}, f => f.pin.origin = 'unknown']) {
    const f = gateFixture(); let verified = false; mutate(f);
    f.options.verifySource = async () => {verified = true; throw Error('Must not reach source verifier');};
    await assert.rejects(verifyPublicationGate(f.db, f.entries, f.options), code('content_authority_mismatch'));
    assert.equal(verified, false);
  }
});

test('independent: shadow configuration never changes a legacy build or invokes the active source verifier', async () => {
  const f = gateFixture();
  f.snapshot.canonical_guides.forEach(row => {row.publicationTarget = structuredClone(legacyTarget); row.publicationPin = null;});
  f.rows.forEach(row => row.publication_target = structuredClone(legacyTarget));
  f.pin.mode = 'shadow';
  f.options.verifySource = async () => {throw Error('Shadow must not verify or claim production authority');};
  assert.equal((await verifyPublicationGate(f.db, f.entries, f.options)).verifiedCount, 2);
});

test('independent: even malformed persisted pipeline authority must fail closed instead of becoming legacy', async t => {
  const f = await databaseFixture(); t.after(() => f.db.close());
  await migrate(f.db, {legacyTarget});
  const unknown = {...contentTarget, pipeline: 'unrecognized-pipeline'};
  await f.db.query('UPDATE guide_publication_authority SET target=$2 WHERE guide_id=$1', [f.guide.id, JSON.stringify(unknown)]);
  const expected = new Map((await f.db.query('SELECT guide_id,document FROM guide_revisions WHERE revision=1')).rows.map(row => [row.guide_id, row.document]));
  await assert.rejects(verifyPublicationGate(f.db, new Map(), {expectedBaselines: expected}), /authority|destination|pipeline|publication/i);
});

test('independent: frozen legacy and content destinations remain distinct despite colliding PR numbers', () => {
  const registry = [legacyTarget, contentTarget];
  const legacyJob = {number: 7, publication_target: legacyTarget}, contentJob = {number: 7, publication_target: contentTarget};
  assert.equal(trustedPublicationTarget(legacyJob.publication_target, registry).target.repository.id, '101');
  assert.equal(trustedPublicationTarget(contentJob.publication_target, registry).target.repository.id, '202');
  assert.throws(() => trustedPublicationTarget(legacyJob.publication_target, [contentTarget]), /no longer configured/);
  assert.throws(() => trustedPublicationTarget({...contentTarget, pipeline: 'unknown'}, registry), /invalid/);
});

function loaderFixture(t, {mode = 'active', remoteTitle} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvme-independent-guide-storage-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const f = gateFixture(), catalog = baselines.map(doc => ({id: doc.id, file: doc.id + '.json'})), catalogBytes = serializeGuideFile(catalog);
  const write = (name, value) => {const target = path.join(root, name); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, Buffer.isBuffer(value) ? value : serializeGuideFile(value));};
  write('editor/content/catalog.json', catalogBytes);
  baselines.forEach(doc => write(`editor/content/${doc.id}.json`, doc));
  f.rows.forEach(row => {write(`content/guides/${row.guide_id}.json`, row.document); write(`content/reviews/${row.id}.json`, approvedFiles(row)[`content/reviews/${row.id}.json`]);});
  const manifest = {schemaVersion: 1, origin: 'guides-v1', catalog: {path: 'baselines/catalog.json', sha256: guideStoreSha256(catalogBytes)}, baselines: {}, guides: {}};
  const files = new Map([...GUIDE_STORE_DOCUMENTATION, ['baselines/catalog.json', catalogBytes]]);
  for (const doc of baselines) {const bytes = serializeGuideFile(doc); files.set(`baselines/${doc.id}.json`, bytes); manifest.baselines[doc.id] = {path: `baselines/${doc.id}.json`, sha256: guideStoreSha256(bytes), contentHash: documentHash(doc)};}
  const row = f.rows[0], document = {...row.document, ...(remoteTitle ? {title: remoteTitle} : {})}, bytes = serializeGuideFile(document);
  files.set(`guides/${row.guide_id}.json`, bytes);
  manifest.guides[row.guide_id] = {path: `guides/${row.guide_id}.json`, sha256: guideStoreSha256(bytes), contentHash: documentHash(document), baselineHash: row.baseline_hash, revision: 2};
  const manifestBytes = serializeGuideFile(manifest); files.set('manifest.json', manifestBytes);
  const pin = {...f.pin, mode, manifestSha256: guideStoreSha256(manifestBytes)};
  const store = validateGuideStore({pin, files, manifestBytes, expectedBaselines: f.options.expectedBaselines, expectedCatalogBytes: catalogBytes, expectedRepository: repository});
  return {...f, root, store, write};
}

test('independent: active v2 public output has opaque proofs for BOTH migrated and legacy guides and no private UUID sentinels', t => {
  const f = loaderFixture(t), built = loadHostedContent(f.root, A, {guideStore: f.store});
  assert.equal(built.release.schemaVersion, 2); assert.equal(built.release.appCommit, A); assert.equal(built.release.contentCommit, C);
  for (const row of f.rows) {
    const receipt = approvedFiles(row)[`content/reviews/${row.id}.json`], proof = built.release.guides[row.guide_id];
    const independent = createHash('sha256').update('pvme-public-approval-v2\0').update(canonical(receipt)).digest('hex');
    assert.deepEqual(proof, {proofId: independent, contentHash: row.content_hash});
    assert.equal(matchesPublicationProof(built.release, row.guide_id, receipt), true);
  }
  const publicOutput = JSON.stringify(built.release) + [...built.published.values()].map(entry => entry.html).join('');
  for (const secret of [...f.rows.flatMap(row => [row.id, row.owner_id, row.reviewer_id]), 'PRIVATE_APPROVAL_SUMMARY_SENTINEL', 'PRIVATE_REVIEW_NOTE_SENTINEL']) assert.equal(publicOutput.includes(secret), false, `Private sentinel leaked: ${secret}`);
  assert.doesNotMatch(JSON.stringify(built.release), /submissionId|contributorId|reviewerId|reviewNote|summary|repository|installationId/);
  assert.equal(fs.readdirSync(path.join(f.root, 'content/reviews')).length, 2, 'Private history remains in app storage');
});

test('independent: missing original private receipt history cannot be replaced by an otherwise valid pinned guide', t => {
  const f = loaderFixture(t); fs.unlinkSync(path.join(f.root, `content/reviews/${f.rows[0].id}.json`));
  assert.throws(() => loadHostedContent(f.root, A, {guideStore: f.store}), /matching review receipt/);
});

test('independent: shadow fetch cannot replace published app content, and active substitution fails the private receipt lineage', t => {
  const f = loaderFixture(t, {mode: 'shadow', remoteTitle: 'An unapproved remote substitution'});
  const built = loadHostedContent(f.root, A, {guideStore: f.store});
  assert.equal(built.published.get(f.rows[0].guide_id).document.title, f.rows[0].document.title);
  assert.equal(built.release.schemaVersion, undefined);
  const active = {...f.store, pin: {...f.store.pin, mode: 'active'}};
  assert.throws(() => loadHostedContent(f.root, A, {guideStore: active}), /matching review receipt.*latest revision/);
});

test('independent: opaque proof binds every immutable receipt fact and rejects v2 UUID disclosure', () => {
  const f = gateFixture(), receipt = f.receipts[0], proofId = publicationProofId(receipt);
  for (const field of ['submissionId', 'contributorId', 'reviewerId', 'summary', 'reviewNote', 'approvedAt', 'baselineHash', 'contentHash', 'baseRevision']) {
    const changed = {...receipt, [field]: typeof receipt[field] === 'number' ? receipt[field] + 1 : String(receipt[field]) + '-changed'};
    assert.notEqual(publicationProofId(changed), proofId, field);
  }
  const release = {schemaVersion: 2, commit: A, appCommit: A, contentCommit: C, contentOrigin: 'guides-v1', guides: {[receipt.guideId]: {proofId, contentHash: receipt.contentHash}}};
  assert.equal(matchesPublicationProof(release, receipt.guideId, receipt), true);
  release.guides[receipt.guideId].submissionId = receipt.submissionId;
  assert.equal(matchesPublicationProof(release, receipt.guideId, receipt), false);
});

// Independent immutable repository graph: the served app may contain exact
// approved bytes even when somebody bypassed the original legacy PR merge.
// The source verifier must distinguish that from a real merged review.
async function sourceProofFixture(t, {legacyMerged = false} = {}) {
  const {guideContentBranch, guidePinBranch} = await import('../github-guide-store.mjs');
  const {guideGitBlobSha} = await import('../guide-github-transport.mjs');
  const f = loaderFixture(t), contentConfig = {...repository, installationId: contentTarget.installationId};
  const appConfig = {...legacyTarget.repository, id: Number(legacyTarget.repository.id), installationId: legacyTarget.installationId};
  const config = {origin: 'guides-v1', pinPath: 'content/guide-store.json', content: contentConfig, app: appConfig};
  function repositoryGraph(settings) {
    const commits = new Map(), pulls = new Map(); let main;
    return {repository: {id: Number(settings.id), owner: settings.owner, repo: settings.repo, base: settings.base},
      add(sha, files, parents = []) {commits.set(sha, {sha, files: new Map(files), parents: parents.map(sha => ({sha})), tree: {sha: 'e'.repeat(40)}});},
      setMain(sha) {main = sha;}, setPull(number, pull) {pulls.set(number, pull);},
      async privateRepo() {}, async ref() {return main;},
      async commit(sha) {assert.ok(commits.has(sha), 'Unknown source commit ' + sha); return commits.get(sha);},
      async filesAt(sha) {return new Map([...commits.get(sha).files].map(([file, bytes]) => [file, {path: file, type: 'blob', mode: '100644', sha: guideGitBlobSha(bytes), size: bytes.length}]));},
      async bytesAt(sha, file, {optional = false} = {}) {const bytes = commits.get(sha)?.files.get(file); if (!bytes && optional) return null; assert.ok(bytes, 'Missing source file ' + file); return Buffer.from(bytes);},
      async jsonAt(sha, file, options) {const bytes = await this.bytesAt(sha, file, options); return bytes === null ? null : JSON.parse(bytes);},
      async pull(number) {assert.ok(pulls.has(number), 'Unknown source PR ' + number); return pulls.get(number);},
      async isDescendant(base, head) {const seen = new Set(); const visit = current => current === base || (!seen.has(current) && (seen.add(current), commits.get(current)?.parents.some(parent => visit(parent.sha)))); return Boolean(visit(head));},
    };
  }
  const content = repositoryGraph(contentConfig), app = repositoryGraph(appConfig), [active, legacy] = f.rows;
  const seed = '1'.repeat(40), contentBranch = '2'.repeat(40), appBase = '3'.repeat(40), pinBranch = '4'.repeat(40), legacyBranch = '5'.repeat(40), releaseApp = '6'.repeat(40);
  const seedManifest = structuredClone(f.store.manifest); delete seedManifest.guides[active.guide_id];
  const seedFiles = new Map(f.store.files); seedFiles.delete(`guides/${active.guide_id}.json`); seedFiles.set('manifest.json', serializeGuideFile(seedManifest));
  content.add(seed, seedFiles); content.add(contentBranch, f.store.files, [seed]); content.add(C, f.store.files, [seed, contentBranch]); content.setMain(C);
  const basePin = {...f.store.pin, mode: 'shadow', contentCommit: seed, manifestSha256: guideStoreSha256(seedFiles.get('manifest.json')), guideIds: []};
  const baseFiles = new Map([['content/guide-store.json', serializeGuideFile(basePin)], ...baselines.map(doc => [`editor/content/${doc.id}.json`, serializeGuideFile(doc)])]);
  const activeReceipt = `content/reviews/${active.id}.json`, legacyReceipt = `content/reviews/${legacy.id}.json`;
  const activeFiles = new Map([...baseFiles, ['content/guide-store.json', serializeGuideFile(f.store.pin)], [activeReceipt, serializeGuideFile(f.receipts[0])]]);
  const legacyReviewFiles = new Map([...baseFiles, [`content/guides/${legacy.guide_id}.json`, serializeGuideFile(legacy.document)], [legacyReceipt, serializeGuideFile(f.receipts[1])]]);
  const releaseFiles = new Map([...activeFiles, [`content/guides/${legacy.guide_id}.json`, serializeGuideFile(legacy.document)], [legacyReceipt, serializeGuideFile(f.receipts[1])]]);
  app.add(appBase, baseFiles); app.add(pinBranch, activeFiles, [appBase]); app.add(A, activeFiles, [appBase, pinBranch]);
  app.add(legacyBranch, legacyReviewFiles, [appBase]); app.add(releaseApp, releaseFiles, legacyMerged ? [A, legacyBranch] : [A]); app.setMain(releaseApp);
  function pull(settings, number, branch, head, mergeSha, merged) {const repo = {id: Number(settings.id), full_name: `${settings.owner}/${settings.repo}`}; return {number, state: merged ? 'closed' : 'open', merged, ...(merged ? {merge_commit_sha: mergeSha, merged_by: {login: appConfig.owner}} : {}), head: {ref: branch, sha: head, repo}, base: {ref: settings.base, repo}};}
  content.setPull(11, pull(contentConfig, 11, guideContentBranch(active), contentBranch, C, true));
  app.setPull(21, pull(appConfig, 21, guidePinBranch(C), pinBranch, A, true));
  app.setPull(31, pull(appConfig, 31, `pvme/review-${legacy.id}`, legacyBranch, releaseApp, legacyMerged));
  active.job_provider = {pipeline: 'content-pin-v1', content: {number: 11, branchSha: contentBranch, mergeSha: C}, pin: {number: 21, branch: guidePinBranch(C), branchSha: pinBranch, mergeSha: A, contentCommit: C}};
  legacy.job_provider = {number: 31, branchSha: legacyBranch, ...(legacyMerged ? {mergeSha: releaseApp} : {})};
  return {f, app, content, input: {pin: f.store.pin, appCommit: releaseApp, rows: f.rows, config, clients: {content, app}, expectedBaselines: f.options.expectedBaselines, expectedCatalogBytes: f.store.files.get('baselines/catalog.json')}};
}

test('independent: v2 source proof rejects exact legacy bytes added directly to app main without merging their original PR', async t => {
  const {verifyGuideReleaseSource} = await import('../github-guide-store.mjs');
  const {input} = await sourceProofFixture(t);
  await assert.rejects(verifyGuideReleaseSource(input), error => ['invalid_merge', 'publication_proof_mismatch', 'approval_not_verified'].includes(error.code));
});

test('independent: v2 source proof accepts an independently merged legacy guide without requiring it in the content authority inventory', async t => {
  const {verifyGuideReleaseSource} = await import('../github-guide-store.mjs');
  const {input, f} = await sourceProofFixture(t, {legacyMerged: true});
  assert.equal(input.pin.guideIds.includes(f.rows[1].guide_id), false);
  assert.equal((await verifyGuideReleaseSource(input)).appCommit, input.appCommit);
});

test('independent: inactive legacy proof stays bound to its original app repository despite a colliding PR number', async t => {
  const {verifyGuideReleaseSource} = await import('../github-guide-store.mjs');
  const {input, f} = await sourceProofFixture(t, {legacyMerged: true});
  f.rows[1].publication_target = {...legacyTarget, repository: {...legacyTarget.repository, id: '999', repo: 'other-app'}};
  await assert.rejects(verifyGuideReleaseSource(input), error => /target|repository|publication/.test(error.code || ''));
});

test('independent: a later app commit cannot substitute an inactive legacy document or private receipt after its original merge', async t => {
  const {verifyGuideReleaseSource} = await import('../github-guide-store.mjs');
  for (const changed of ['document', 'receipt']) {
    const {input, f, app} = await sourceProofFixture(t, {legacyMerged: true});
    const files = new Map();
    for (const file of (await app.filesAt(input.appCommit)).keys()) files.set(file, await app.bytesAt(input.appCommit, file));
    const legacy = f.rows[1];
    const file = changed === 'document' ? `content/guides/${legacy.guide_id}.json` : `content/reviews/${legacy.id}.json`;
    const value = JSON.parse(files.get(file));
    if (changed === 'document') value.title = 'A later unapproved title'; else value.reviewNote = 'A later unapproved review note';
    files.set(file, serializeGuideFile(value));
    const wrongA = '7'.repeat(40); app.add(wrongA, files, [input.appCommit]); app.setMain(wrongA); input.appCommit = wrongA;
    await assert.rejects(verifyGuideReleaseSource(input), error => /proof|mismatch|merge|approval/.test(error.code || ''), changed);
  }
});

test('independent: every full-build v2 output file excludes all legacy and migrated private approval UUIDs and notes', async t => {
  const {execFileSync} = await import('node:child_process');
  const {generateKeyPairSync} = await import('node:crypto');
  const {fileURLToPath} = await import('node:url');
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pvme-independent-v2-output-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const directory of ['scripts', 'reader', 'src', 'editor', 'server']) fs.cpSync(path.join(repositoryRoot, directory), path.join(root, directory), {recursive: true, filter: source => !['node_modules', 'dist', '.runtime'].includes(path.basename(source))});
  fs.copyFileSync(path.join(repositoryRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
  fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const write = (file, value) => {const target = path.join(root, file); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, Buffer.isBuffer(value) ? value : serializeGuideFile(value));};
  const rows = [approval(baselines[0]), approval(baselines[1], legacyTarget)];
  for (const row of rows) {write(`content/guides/${row.guide_id}.json`, row.document); write(`content/reviews/${row.id}.json`, approvedFiles(row)[`content/reviews/${row.id}.json`]);}
  const catalogBytes = fs.readFileSync(path.join(root, 'editor/content/catalog.json')), catalog = JSON.parse(catalogBytes);
  const manifest = {schemaVersion: 1, origin: 'guides-v1', catalog: {path: 'baselines/catalog.json', sha256: guideStoreSha256(catalogBytes)}, baselines: {}, guides: {}};
  const files = new Map([...GUIDE_STORE_DOCUMENTATION, ['baselines/catalog.json', catalogBytes]]);
  for (const item of catalog) {
    const bytes = fs.readFileSync(path.join(root, 'editor/content', item.file)), document = JSON.parse(bytes);
    files.set(`baselines/${item.id}.json`, bytes); manifest.baselines[item.id] = {path: `baselines/${item.id}.json`, sha256: guideStoreSha256(bytes), contentHash: documentHash(document)};
  }
  const active = rows[0], bytes = serializeGuideFile(active.document);
  files.set(`guides/${active.guide_id}.json`, bytes);
  manifest.guides[active.guide_id] = {path: `guides/${active.guide_id}.json`, sha256: guideStoreSha256(bytes), contentHash: active.content_hash, baselineHash: active.baseline_hash, revision: 2};
  const manifestBytes = serializeGuideFile(manifest); files.set('manifest.json', manifestBytes);
  const pin = {schemaVersion: 1, mode: 'active', origin: 'guides-v1', repository, contentCommit: C, manifestSha256: guideStoreSha256(manifestBytes), guideIds: [active.guide_id]};
  write('content/guide-store.json', pin);
  for (const [file, bytes] of files) write(`.runtime/mock-store/${file}`, bytes);
  const entry = `
import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
const directory=path.resolve('.runtime/mock-store'),files=new Map();
function walk(dir,prefix=''){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){const file=prefix+ent.name;if(ent.isDirectory())walk(path.join(dir,ent.name),file+'/');else files.set(file,fs.readFileSync(path.join(dir,ent.name)));}} walk(directory);
const sha=bytes=>createHash('sha1').update(Buffer.from('blob '+bytes.length+'\\0')).update(bytes).digest('hex');
const blobs=new Map([...files].map(([file,bytes])=>[sha(bytes),bytes]));
const entries=[{path:'baselines',type:'tree',mode:'040000',sha:'e'.repeat(40)},{path:'guides',type:'tree',mode:'040000',sha:'f'.repeat(40)},...[...files].map(([file,bytes])=>({path:file,type:'blob',mode:'100644',sha:sha(bytes),size:bytes.length}))];
const permissions={contents:'read',pull_requests:'read',metadata:'read'},rep={id:202,private:true,full_name:'pvme-wiki/guides'};
globalThis.fetch=async(url,options={})=>{const u=new URL(url);if(u.origin!=='https://api.github.com')throw Error('No external fixture requests');let value;
if(u.pathname==='/app/installations/333')value={id:333,app_id:444,account:{login:'pvme-wiki'},repository_selection:'selected',permissions,suspended_at:null};
else if(u.pathname==='/app/installations/333/access_tokens')value={token:'READ_ONLY_FIXTURE_TOKEN',expires_at:new Date(Date.now()+3600000).toISOString(),permissions,repository_selection:'selected',repositories:[rep]};
else {if(options.method!=='GET')throw Error('No repository writes in fixture');const p=u.pathname.replace('/repos/pvme-wiki/guides','');
if(p==='')value=rep;else if(p==='/git/ref/heads/main')value={ref:'refs/heads/main',object:{type:'commit',sha:'c'.repeat(40)}};
else if(p==='/git/commits/'+'c'.repeat(40))value={sha:'c'.repeat(40),tree:{sha:'d'.repeat(40)}};
else if(p==='/git/trees/'+'d'.repeat(40))value={sha:'d'.repeat(40),truncated:false,tree:entries};
else if(p.startsWith('/git/blobs/')){const id=p.slice('/git/blobs/'.length),bytes=blobs.get(id);if(!bytes)throw Error('Unknown fixture blob');value={sha:id,size:bytes.length,encoding:'base64',content:bytes.toString('base64')};}else throw Error('Unexpected fixture request '+p);}
return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});};
await import('./scripts/build-fullstack.mjs');
`;
  write('fixture-build.mjs', Buffer.from(entry));
  const {privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048, privateKeyEncoding: {type: 'pkcs8', format: 'pem'}, publicKeyEncoding: {type: 'spki', format: 'pem'}});
  const env = {...Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'NODE_EXTRA_CA_CERTS', 'LANG'].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])), VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: A, GUIDE_STORE_REPOSITORY_ID: '202', GUIDE_STORE_OWNER: 'pvme-wiki', GUIDE_STORE_REPO: 'guides', GUIDE_STORE_BASE_BRANCH: 'main', GUIDE_STORE_READ_APP_ID: '444', GUIDE_STORE_READ_INSTALLATION_ID: '333', GUIDE_STORE_READ_PRIVATE_KEY: privateKey};
  execFileSync(process.execPath, ['fixture-build.mjs'], {cwd: root, env, stdio: 'pipe', timeout: 60000});
  const release = JSON.parse(fs.readFileSync(path.join(root, 'dist/data/release.json')));
  assert.equal(release.schemaVersion, 2); assert.deepEqual(Object.keys(release.guides).sort(), rows.map(row => row.guide_id).sort());
  const sentinels = [...rows.flatMap(row => [row.id, row.owner_id, row.reviewer_id]), 'PRIVATE_APPROVAL_SUMMARY_SENTINEL', 'PRIVATE_REVIEW_NOTE_SENTINEL', 'READ_ONLY_FIXTURE_TOKEN'];
  let scanned = 0;
  function scan(directory) {for (const ent of fs.readdirSync(directory, {withFileTypes: true})) {const file = path.join(directory, ent.name); if (ent.isDirectory()) scan(file); else {const bytes = fs.readFileSync(file); for (const secret of sentinels) assert.equal(bytes.includes(Buffer.from(secret)), false, `Private approval data in ${path.relative(root, file)}`); scanned++;}}}
  scan(path.join(root, 'dist')); assert.ok(scanned > 100);
  for (const forbidden of ['content/reviews', 'content/guides', '.runtime', '.git', '.env', 'server', 'api']) assert.equal(fs.existsSync(path.join(root, 'dist', forbidden)), false, forbidden);
});

test('independent: irrelevant approval history does not wedge a genuine proof while active ambiguity requires authority', async t => {
  const {verifyGuideReleaseSource} = await import('../github-guide-store.mjs');
  for (const state of ['queued-without-proof', 'blocked', 'replacement', 'superseded']) {
    const {input, f} = await sourceProofFixture(t, {legacyMerged: true});
    const competing = {...structuredClone(f.rows[0]), id: randomUUID(), owner_id: randomUUID(), reviewer_id: randomUUID()};
    if (state === 'queued-without-proof') {competing.job_state = 'queued'; competing.job_provider = {};}
    if (state === 'blocked') competing.job_state = 'blocked';
    if (state === 'replacement') competing.job_provider.replacementId = randomUUID();
    if (state === 'superseded') competing.superseded = true;
    input.rows.unshift(competing);
    assert.equal((await verifyGuideReleaseSource(input)).appCommit, input.appCommit, state);
  }
  const {input, f} = await sourceProofFixture(t, {legacyMerged: true});
  const genuine = f.rows[0];
  const competing = {...structuredClone(genuine), id: randomUUID(), owner_id: randomUUID(), reviewer_id: randomUUID()};
  input.rows.unshift(competing);
  await assert.rejects(verifyGuideReleaseSource(input), code('approval_not_verified'), 'Two active merged-proof candidates must not select a receipt by input order');
  for (const row of [genuine, competing]) {row.current_publication_id = genuine.id; row.current_revision = 2; row.current_hash = genuine.content_hash;}
  assert.equal((await verifyGuideReleaseSource(input)).appCommit, input.appCommit, 'The authoritative canonical publication identifies its exact receipt');
});
