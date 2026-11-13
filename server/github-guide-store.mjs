import { approvedFiles, PublicationError, publicationRequestSignal } from './github.mjs';
import { canonical, documentHash, iso } from './core.mjs';
import { hasValidApproval } from './approval.mjs';
import { assertDocument } from '../editor/shared/model.mjs';
import { validateGuidePin, validateGuideManifest, updateGuideManifest, serializeGuideFile, guideStoreSha256, guideStorePaths, GUIDE_STORE_LIMITS } from './content-store.mjs';
import { matchesPublicationProof } from './publication-proof.mjs';
import { createGuideGitHubClients, guideGitBlobSha, readPublicationJson } from './guide-github-transport.mjs';
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const reject = (code, message, retryable = false) => { throw new PublicationError(code, message, { retryable }); };
const identity = value => ({ id: Number(value.id), owner: value.owner, repo: value.repo, base: value.base });
const equal = (a, b) => canonical(a) === canonical(b);
export const guideContentBranch = row => `pvme/guide-${row.guide_id}-${row.content_hash}`;
export const guidePinBranch = contentCommit => `pvme/pin-${contentCommit}`;
const receiptPath = row => `content/reviews/${row.id}.json`;
const receiptFor = row => approvedFiles(row)[receiptPath(row)];
const rowProvider = row => row.job_provider || row.provider || {};
const eligibleApproval = row => Boolean(row && ['approved', 'publishing', 'published'].includes(row.status) && hasValidApproval(row) && !row.superseded && !rowProvider(row).replacementId && (!row.job_state || ['queued', 'working', 'retry', 'awaiting_merge', 'awaiting_deployment', 'published'].includes(row.job_state)));
const reviewReference = part => Number.isSafeInteger(part?.number) && part.number > 0 && SHA.test(part.branchSha || '');

function approvedRow(row, config, { requireTarget = true } = {}) {
  if (!row || !UUID.test(row.id || '') || !['approved', 'publishing', 'published'].includes(row.status) || !hasValidApproval(row) || documentHash(row.document) !== row.content_hash || documentHash(row.baseline_document) !== row.baseline_hash || row.document?.id !== row.guide_id || row.baseline_document?.id !== row.guide_id || !Number.isSafeInteger(row.base_revision) || row.base_revision < 1 || row.superseded || rowProvider(row).replacementId || (row.job_state && !['queued', 'working', 'retry', 'awaiting_merge', 'awaiting_deployment', 'published'].includes(row.job_state))) reject('snapshot_corrupt', 'The guide approval is not an immutable active snapshot.');
  assertDocument(row.document, { baseline: row.baseline_document });
  const target = row.publication_target;
  if (requireTarget && (!target || target.pipeline !== 'content-pin-v1' || target.origin !== config.origin || !equal({ ...target.repository, id: Number(target.repository?.id) }, identity(config.content)) || String(target.installationId) !== String(config.content.installationId))) reject('publication_target_mismatch', 'This approval belongs to a different publication pipeline or repository.');
  // Constructing the full private receipt also verifies any owner self-approval.
  receiptFor(row);
  return row;
}
function verifyPull(pull, client, branch, head, { merged = false } = {}) {
  const expected = `${client.repository.owner}/${client.repository.repo}`.toLowerCase();
  if (!Number.isSafeInteger(pull?.number) || pull.number < 1 || pull.head?.sha !== head || pull.head?.ref !== branch || pull.base?.ref !== client.repository.base || pull.head?.repo?.full_name?.toLowerCase() !== expected || pull.base?.repo?.full_name?.toLowerCase() !== expected || Number(pull.head?.repo?.id) !== client.repository.id || Number(pull.base?.repo?.id) !== client.repository.id) reject('pull_request_conflict', 'The review points outside its exact publication repository or branch.');
  if (pull.state === 'closed' && !pull.merged) reject('pull_request_closed', 'The publication review was closed without merging.');
  if (merged && (!pull.merged || !SHA.test(pull.merge_commit_sha || ''))) reject('invalid_merge', 'The publication needs an exact merged pull-request commit.');
}
function providerPart(pull, branch, branchSha) {
  return { number: pull.number, branch, branchSha, ...(pull.merged ? { mergeSha: pull.merge_commit_sha } : {}) };
}

/** Exact tree comparison avoids GitHub compare's 300-file truncation boundary. */
export async function verifyGuidePublicationDiff(client, base, head, files) {
  const before = await client.filesAt(base), after = await client.filesAt(head);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed = [...paths].filter(path => !equal(before.get(path) || null, after.get(path) || null));
  const expected = [...files].filter(([path, bytes]) => before.get(path)?.sha !== guideGitBlobSha(bytes) || before.get(path)?.mode !== '100644');
  if (changed.length !== expected.length || expected.some(([path, bytes]) => after.get(path)?.type !== 'blob' || after.get(path)?.mode !== '100644' || after.get(path)?.sha !== guideGitBlobSha(bytes) || !changed.includes(path))) reject('branch_conflict', 'The publication branch contains changes beyond its approved files.');
}
function manifestOptions(options) {
  return { expectedBaselines: options.expectedBaselines, expectedCatalogBytes: options.expectedCatalogBytes };
}
async function manifestAt(client, commit, options) {
  const bytes = await client.bytesAt(commit, 'manifest.json');
  if (bytes.length > GUIDE_STORE_LIMITS.manifestBytes) reject('manifest_mismatch', 'The guide manifest exceeds its size limit.');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { reject('manifest_mismatch', 'The guide manifest is invalid.'); }
  validateGuideManifest(manifest, manifestOptions(options));
  const files = await client.filesAt(commit), expected = guideStorePaths(manifest);
  if (files.size !== expected.length || expected.some(path => files.get(path)?.mode !== '100644' || files.get(path)?.type !== 'blob') || [...files.values()].some(file => Number.isFinite(file.size) && file.size > GUIDE_STORE_LIMITS.fileBytes) || [...files.values()].reduce((total, file) => total + (file.size || 0), 0) > GUIDE_STORE_LIMITS.totalBytes) reject('unexpected_files', 'The content repository includes unsupported files or payload size.');
  return { manifest, bytes };
}
async function baselineAt(client, commit, row, options) {
  const { manifest } = await manifestAt(client, commit, options), entry = manifest.guides[row.guide_id] || manifest.baselines[row.guide_id];
  if (!entry || entry.contentHash !== row.baseline_hash || (manifest.guides[row.guide_id]?.revision || 1) !== row.base_revision) reject('source_conflict', 'The source guide changed after approval. A fresh submission is required.');
  const bytes = await client.bytesAt(commit, entry.path);
  const document = await client.jsonAt(commit, entry.path);
  if (guideStoreSha256(bytes) !== entry.sha256 || documentHash(document) !== row.baseline_hash || !equal(document, row.baseline_document)) reject('source_conflict', 'The approved baseline differs from the exact content-store source.');
  return manifest;
}
async function contentPlan(client, base, row, options) {
  const manifest = await baselineAt(client, base, row, options);
  const updated = updateGuideManifest(manifest, { guideId: row.guide_id, document: row.document, baselineHash: row.baseline_hash, revision: row.base_revision + 1 }, manifestOptions(options));
  return { ...updated, files: new Map([[`guides/${row.guide_id}.json`, updated.guideBytes], ['manifest.json', updated.manifestBytes]]) };
}
async function verifyContentBranch(client, head, row, options) {
  const commit = await client.commit(head);
  if (commit.parents.length !== 1) reject('branch_conflict', 'The guide review branch has unexpected history.');
  const base = commit.parents[0].sha, plan = await contentPlan(client, base, row, options);
  await verifyGuidePublicationDiff(client, base, head, plan.files);
  return plan;
}
async function verifyContentMerge(client, row, part, options, { contentCommit } = {}) {
  const pull = await client.pull(part.number);
  verifyPull(pull, client, guideContentBranch(row), part.branchSha, { merged: true });
  await verifyContentBranch(client, part.branchSha, row, options);
  const mergeSha = pull.merge_commit_sha;
  if (part.mergeSha && part.mergeSha !== mergeSha) reject('merge_conflict', 'The recorded content merge changed.');
  const { manifest } = await manifestAt(client, mergeSha, options), entry = manifest.guides[row.guide_id];
  const bytes = await client.bytesAt(mergeSha, `guides/${row.guide_id}.json`);
  if (!entry || entry.contentHash !== row.content_hash || entry.baselineHash !== row.baseline_hash || entry.revision !== row.base_revision + 1 || guideStoreSha256(bytes) !== entry.sha256 || !equal(await client.jsonAt(mergeSha, entry.path), row.document)) reject('merge_conflict', 'The merged guide differs from the exact approved snapshot.');
  if (!await client.isDescendant(mergeSha, contentCommit || await client.ref())) reject('pin_not_forward', 'The guide merge is not on the configured content history.');
  return { ...providerPart(pull, guideContentBranch(row), part.branchSha), mergeSha };
}
async function verifyLegacyMerge(client, row, { config, appCommit } = {}) {
  const target = row.publication_target;
  if (!config || target?.pipeline !== 'legacy-v1' || target.origin !== 'legacy-v1' || !equal({ ...target.repository, id: Number(target.repository?.id) }, identity(config.app)) || String(target.installationId) !== String(config.app.installationId)) reject('publication_target_mismatch', 'The legacy review belongs to a different original application repository or installation.');
  const provider = rowProvider(row), branch = `pvme/review-${row.id}`;
  if (!provider.number || !provider.branchSha) reject('approval_not_verified', 'A seeded legacy guide lacks its original merged review proof.');
  const pull = await client.pull(provider.number);
  verifyPull(pull, client, branch, provider.branchSha, { merged: true });
  const commit = await client.commit(provider.branchSha);
  if (commit.parents.length !== 1) reject('branch_conflict', 'The legacy review branch has unexpected history.');
  const parent = commit.parents[0].sha;
  const baseline = await client.jsonAt(parent, `content/guides/${row.guide_id}.json`, { optional: true }) || await client.jsonAt(parent, `editor/content/${row.guide_id}.json`);
  if (!equal(baseline, row.baseline_document)) reject('source_conflict', 'The legacy approval baseline differs from its reviewed source.');
  const files = new Map();
  for (const [path, expected] of Object.entries(approvedFiles(row))) {
    if (!equal(await client.jsonAt(provider.branchSha, path), expected) || !equal(await client.jsonAt(pull.merge_commit_sha, path), expected)) reject('merge_conflict', 'The seeded legacy guide differs from its exact merged approval.');
    files.set(path, await client.bytesAt(provider.branchSha, path));
  }
  await verifyGuidePublicationDiff(client, parent, provider.branchSha, files);
  if (provider.mergeSha && provider.mergeSha !== pull.merge_commit_sha) reject('merge_conflict', 'The recorded legacy merge differs from GitHub.');
  if ((appCommit && !await client.isDescendant(pull.merge_commit_sha, appCommit)) || !await client.isDescendant(pull.merge_commit_sha, await client.ref())) reject('pin_not_forward', 'The original legacy approval is absent from application history.');
}
async function pinAt(client, commit, config) {
  return validateGuidePin(await client.jsonAt(commit, config.pinPath), { expectedRepository: identity(config.content) });
}
async function checkForward(client, from, to) {
  if (!await client.isDescendant(from, to)) reject('pin_not_forward', 'A stale, backward or divergent content pin cannot be published.');
}
async function immutableSource(client, from, to, options) {
  await checkForward(client, from, to);
  const old = await manifestAt(client, from, options), next = await manifestAt(client, to, options);
  if (!equal(old.manifest.catalog, next.manifest.catalog) || !equal(old.manifest.baselines, next.manifest.baselines) || Object.keys(old.manifest.guides).some(id => !Object.hasOwn(next.manifest.guides, id))) reject('baseline_mismatch', 'The content update changes or removes immutable source inventory.');
  const before = await client.filesAt(from), after = await client.filesAt(to);
  for (const [path, file] of before) if (path !== 'manifest.json' && !path.startsWith('guides/') && !equal(file, after.get(path))) reject('baseline_mismatch', 'The content update changes an immutable baseline or licence file.');
  return next;
}
function uniqueRows(rows, manifest, config, authorityIds = Object.keys(manifest.guides), currentRow, currentPart) {
  if (!Array.isArray(rows)) reject('approval_not_verified', 'The complete private approval inventory is unavailable.');
  const selected = [];
  for (const [id, entry] of Object.entries(manifest.guides).filter(([id]) => authorityIds.includes(id))) {
    const matchesEntry = row => eligibleApproval(row) && row.guide_id === id && row.content_hash === entry.contentHash && row.baseline_hash === entry.baselineHash && row.base_revision + 1 === entry.revision;
    const matches = rows.filter(matchesEntry);
    // The currently leased FIFO job has just supplied an independently verified
    // merged content PR. A later identical queued approval cannot replace it.
    let chosen = matchesEntry(currentRow) && reviewReference(currentPart) && SHA.test(currentPart.mergeSha || '') ? currentRow : null;
    if (!chosen) {
      const canonicalRows = matches.filter(row => row.current_publication_id === row.id && row.current_revision === row.base_revision + 1 && row.current_hash === row.content_hash);
      if (canonicalRows.length === 1) chosen = canonicalRows[0];
      else if (canonicalRows.length > 1) reject('approval_not_verified', 'The canonical publication evidence is ambiguous. A maintainer must reconcile it.');
      else if (matches.length === 1) chosen = matches[0];
      else {
        const evidenced = matches.filter(row => reviewReference(row.publication_target?.pipeline === 'legacy-v1' ? rowProvider(row) : rowProvider(row).content));
        if (evidenced.length === 1) chosen = evidenced[0];
      }
    }
    if (!chosen) reject('approval_not_verified', 'The guide needs one eligible exact approval with unambiguous publication evidence. A maintainer must reconcile competing active reviews.');
    selected.push(approvedRow(chosen, config, { requireTarget: false }));
  }
  return selected;
}
async function verifyRowsAtContent(rows, snapshot, contentCommit, clients, config, options, currentRow, currentPart, authorityIds) {
  const selected = uniqueRows(rows, snapshot.manifest, config, authorityIds, currentRow, currentPart);
  let next = 0, failure;
  const verify = async row => {
    const entry = snapshot.manifest.guides[row.guide_id], bytes = await clients.content.bytesAt(contentCommit, entry.path);
    if (guideStoreSha256(bytes) !== entry.sha256 || !equal(await clients.content.jsonAt(contentCommit, entry.path), row.document)) reject('approval_content_mismatch', 'A content-store guide differs from its private approval.');
    if (row.publication_target?.pipeline === 'legacy-v1') {
      await verifyLegacyMerge(clients.app, row, { config });
      return;
    }
    approvedRow(row, config);
    const provider = row.id === currentRow?.id ? { content: currentPart } : rowProvider(row);
    if (provider.pipeline && provider.pipeline !== 'content-pin-v1') reject('publication_target_mismatch', 'A guide proof belongs to a different publication pipeline.');
    const part = provider.content;
    if (!part) reject('approval_not_verified', 'A guide lacks its exact merged content review proof.');
    await verifyContentMerge(clients.content, row, part, options, { contentCommit });
  };
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (!failure && next < selected.length) {
      const row = selected[next++];
      try { await verify(row); } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return selected;
}
async function pinFiles(pin, rows, config, app, base) {
  const files = new Map([[config.pinPath, serializeGuideFile(pin)]]);
  for (const row of rows) {
    const path = receiptPath(row), expected = receiptFor(row);
    const existing = await app.bytesAt(base, path, { optional: true });
    if (existing) {
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(existing)); } catch { reject('merge_conflict', 'An existing private receipt is invalid.'); }
      if (!equal(value, expected)) reject('merge_conflict', 'An existing private receipt differs from its immutable approval.');
      continue; // Existing receipt bytes and Git blobs are never rewritten.
    }
    files.set(path, serializeGuideFile(expected));
  }
  return files;
}
async function verifyAppBranch(clients, head, pin, rows, config, options) {
  const commit = await clients.app.commit(head);
  if (commit.parents.length !== 1) reject('branch_conflict', 'The application pin review has unexpected history.');
  const before = await pinAt(clients.app, commit.parents[0].sha, config);
  if ((before.mode !== 'active' && !(before.mode === 'shadow' && options.allowActivation === true)) || pin.mode !== 'active' || before.guideIds.some(id => !pin.guideIds.includes(id))) reject('authority_mismatch', 'The pin review cannot change activation mode or drop existing guide authority.');
  const previous = await manifestAt(clients.content, before.contentCommit, options);
  const next = await immutableSource(clients.content, before.contentCommit, pin.contentCommit, options);
  for (const id of Object.keys(next.manifest.guides)) if (!pin.guideIds.includes(id) && !equal(previous.manifest.guides[id] || null, next.manifest.guides[id])) reject('publication_target_mismatch', 'A pin review cannot change a guide outside its authority.');
  for (const row of rows) if (row.publication_target?.pipeline === 'legacy-v1' && !equal(previous.manifest.guides[row.guide_id], next.manifest.guides[row.guide_id])) reject('publication_target_mismatch', 'A legacy approval cannot authorize a new content-repository change.');
  await verifyGuidePublicationDiff(clients.app, commit.parents[0].sha, head, await pinFiles(pin, rows, config, clients.app, commit.parents[0].sha));
  if (!equal(await pinAt(clients.app, head, config), pin)) reject('pin_conflict', 'The reviewed application pin differs from the exact content commit.');
}
async function verifyAppMerge(clients, part, pin, rows, config, options) {
  const pull = await clients.app.pull(part.number);
  verifyPull(pull, clients.app, guidePinBranch(pin.contentCommit), part.branchSha, { merged: true });
  await verifyAppBranch(clients, part.branchSha, pin, rows, config, options);
  // An owner manually merges this PR. The publisher never calls a merge API.
  if (pull.merged_by?.login?.toLowerCase() !== config.app.owner.toLowerCase()) reject('owner_merge_required', 'The personal application owner must merge the content-pin review.');
  const mergeSha = pull.merge_commit_sha;
  if (part.mergeSha && part.mergeSha !== mergeSha) reject('merge_conflict', 'The recorded application pin merge changed.');
  if (!equal(await pinAt(clients.app, mergeSha, config), pin)) reject('pin_conflict', 'The merged application pin differs from the reviewed content commit.');
  for (const row of rows) if (!equal(await clients.app.jsonAt(mergeSha, receiptPath(row)), receiptFor(row)) || !(await clients.app.bytesAt(mergeSha, receiptPath(row))).equals(await clients.app.bytesAt(part.branchSha, receiptPath(row)))) reject('merge_conflict', 'A merged private receipt differs from its immutable approval.');
  if (!await clients.app.isDescendant(mergeSha, await clients.app.ref())) reject('pin_not_forward', 'The application pin merge is not on the configured application history.');
  return { ...part, mergeSha };
}

/** New pipeline only. Legacy jobs continue using createGitHubApp unchanged. */
export function createGitHubGuideStore(config, options = {}) {
  const clients = options.clients || createGuideGitHubClients(config, options);
  const configured = () => {
    if (config.origin !== 'guides-v1' || config.pinPath !== 'content/guide-store.json' || !options.pinController?.withLease || typeof options.approvalRows !== 'function' || !(options.expectedBaselines instanceof Map) || !options.expectedCatalogBytes) reject('publication_unconfigured', 'The split guide publisher is staged and requires complete verified configuration.');
  };
  async function repositories() {
    await clients.content.privateRepo({ ownerType: 'Organization' });
    await clients.app.privateRepo({ ownerType: 'User' });
  }
  async function pullFor(client, branch, head, title, body) {
    const found = await client.pulls(branch);
    const pull = found.length ? await client.pull(found[0].number) : await client.createPull(branch, title, body);
    verifyPull(pull, client, branch, head);
    return pull;
  }
  async function ensurePin(row, content, provider) {
    return options.pinController.withLease(config.origin, async lease => {
      let state = await lease.read();
      // Durable checkpoint always wins over a lost worker acknowledgement.
      let part = provider.pin || (!state.provider?.pin?.mergeSha ? state.provider?.pin : undefined);
      if (!provider.pin && part && (await clients.app.pull(part.number)).merged) part = undefined;
      const appBase = await clients.app.ref(), currentPin = await pinAt(clients.app, appBase, config);
      if (currentPin.mode !== 'active' && !(currentPin.mode === 'shadow' && options.allowActivation === true)) reject('publication_unconfigured', 'The guide-store authority has not been activated by its owner.');
      const intent = provider.pin ? null : state.provider?.pinIntent;
      const candidate = part?.contentCommit || intent?.contentCommit || await clients.content.ref();
      if (provider.pin && (await clients.app.pull(provider.pin.number)).merged) {
        const recordedPin = await pinAt(clients.app, provider.pin.branchSha, config);
        const snapshot = await manifestAt(clients.content, recordedPin.contentCommit, options);
        const rows = await verifyRowsAtContent(await options.approvalRows(recordedPin.guideIds), snapshot, recordedPin.contentCommit, clients, config, options, row, content, recordedPin.guideIds);
        const merged = await verifyAppMerge(clients, provider.pin, recordedPin, rows, config, options);
        if (!state.contentCommit || state.contentCommit === recordedPin.contentCommit) {
          let appCommit = merged.mergeSha;
          if (state.appCommit && state.appCommit !== appCommit) {
            if (await clients.app.isDescendant(appCommit, state.appCommit)) appCommit = state.appCommit;
            else await checkForward(clients.app, state.appCommit, appCommit);
          }
          await lease.checkpoint({ expectedVersion: state.version, contentCommit: recordedPin.contentCommit, appCommit, provider: { pin: merged }, isDescendant: (base, next) => clients.content.isDescendant(base, next) });
        }
        return { state: 'awaiting_deployment', provider: { ...provider, content, contentMergeSha: content.mergeSha, contentCommit: recordedPin.contentCommit, pin: merged, websiteNumber: merged.number, websiteBranchSha: merged.branchSha, phase: 'deployment', appPinned: true, merged: true, mergeSha: merged.mergeSha, appMergeSha: merged.mergeSha, appCommit: merged.mergeSha } };
      }
      if ((part || intent) && !await clients.content.isDescendant(content.mergeSha, candidate)) return { state: 'awaiting_merge', provider: { ...provider, content, contentMergeSha: content.mergeSha, phase: 'website_update', merged: false } };
      await checkForward(clients.content, content.mergeSha, candidate);
      await checkForward(clients.content, currentPin.contentCommit, candidate);
      await checkForward(clients.content, candidate, await clients.content.ref());
      const snapshot = await immutableSource(clients.content, currentPin.contentCommit, candidate, options);
      const previous = await manifestAt(clients.content, currentPin.contentCommit, options);
      const changedIds = Object.keys(snapshot.manifest.guides).filter(id => !equal(previous.manifest.guides[id] || null, snapshot.manifest.guides[id]));
      const authorityIds = [...new Set([...currentPin.guideIds, ...changedIds])].sort();
      const rows = await verifyRowsAtContent(await options.approvalRows(authorityIds), snapshot, candidate, clients, config, options, row, content, authorityIds);
      if (rows.some(candidate => changedIds.includes(candidate.guide_id) && candidate.publication_target?.pipeline !== 'content-pin-v1')) reject('publication_target_mismatch', 'A changed guide has not completed its frozen content-store handoff.');
      const pin = validateGuidePin({ ...currentPin, mode: 'active', contentCommit: candidate, manifestSha256: guideStoreSha256(snapshot.bytes), guideIds: authorityIds }, { expectedRepository: identity(config.content) });
      const branch = guidePinBranch(candidate);
      let head;
      if (part) head = part.branchSha;
      else {
        const prior = await clients.app.pulls(branch);
        head = await clients.app.ref(branch, { optional: true });
        if (!head && prior.length) {
          const recovered = await clients.app.pull(prior[0].number);
          if (!recovered.merged) reject('branch_conflict', 'The application pin branch was removed before merging.');
          head = recovered.head.sha;
        }
        if (!head) {
          const intendedBase = intent?.appBase || appBase;
          if (intent && (intent.branch !== branch || !equal(intent.guideIds, pin.guideIds))) reject('pin_conflict', 'The durable pin intent differs from the reviewed content inventory.');
          if (!intent) state = await lease.checkpoint({ expectedVersion: state.version, contentCommit: candidate, ...(state.appCommit ? { appCommit: state.appCommit } : {}), provider: { pinIntent: { contentCommit: candidate, appBase: intendedBase, branch, guideIds: pin.guideIds } }, isDescendant: (base, next) => clients.content.isDescendant(base, next) });
          else await lease.read(); // Fence the worker immediately before external writes.
          head = await clients.app.createBranch(branch, intendedBase, await pinFiles(pin, rows, config, clients.app, intendedBase), `Pin reviewed guide content ${candidate}`, iso(row.reviewed_at));
        }
      }
      await verifyAppBranch(clients, head, pin, rows, config, options);
      if (!part && !state.provider?.pinIntent) state = await lease.checkpoint({ expectedVersion: state.version, contentCommit: candidate, ...(state.appCommit ? { appCommit: state.appCommit } : {}), provider: { pinIntent: { contentCommit: candidate, appBase: (await clients.app.commit(head)).parents[0].sha, branch, guideIds: pin.guideIds } }, isDescendant: (base, next) => clients.content.isDescendant(base, next) });
      await lease.read(); // A lost lease may recover this deterministic branch, never create another intent.
      const pull = await pullFor(clients.app, branch, head, `Pin reviewed guide content ${candidate.slice(0, 12)}`, `Review the guide content pin and the complete private receipts for this content commit.\n\nContent commit: ${candidate}\n\nThe personal application owner must merge this review after its checks pass. The publisher never merges it automatically.`);
      part = { ...providerPart(pull, branch, head), contentCommit: candidate };
      const checkpoint = await lease.checkpoint({ expectedVersion: state.version, contentCommit: candidate, ...(state.appCommit ? { appCommit: state.appCommit } : {}), provider: { pin: part }, isDescendant: (base, next) => clients.content.isDescendant(base, next) });
      if (!pull.merged) return { state: 'awaiting_merge', provider: { ...provider, content, contentMergeSha: content.mergeSha, contentCommit: candidate, pin: part, websiteNumber: part.number, websiteBranchSha: part.branchSha, phase: 'website_update', merged: false } };
      part = await verifyAppMerge(clients, part, pin, rows, config, options);
      await lease.checkpoint({ expectedVersion: checkpoint.version, contentCommit: candidate, appCommit: part.mergeSha, provider: { pin: part }, isDescendant: (base, next) => clients.content.isDescendant(base, next) });
      return { state: 'awaiting_deployment', provider: { ...provider, content, contentMergeSha: content.mergeSha, contentCommit: candidate, pin: part, websiteNumber: part.number, websiteBranchSha: part.branchSha, phase: 'deployment', appPinned: true, merged: true, mergeSha: part.mergeSha, appMergeSha: part.mergeSha, appCommit: part.mergeSha } };
    });
  }
  return {
    async ensurePullRequest(row) {
      configured(); approvedRow(row, config); await repositories();
      const appBase = await clients.app.ref(), pin = await pinAt(clients.app, appBase, config);
      if (pin.mode !== 'active' && !(pin.mode === 'shadow' && options.allowActivation === true)) reject('publication_unconfigured', 'The guide-store authority has not been activated by its owner.');
      const branch = guideContentBranch(row), prior = await clients.content.pulls(branch);
      let head = await clients.content.ref(branch, { optional: true });
      if (!head && prior.length) {
        const old = await clients.content.pull(prior[0].number);
        if (!old.merged) reject('branch_conflict', 'The guide review branch was removed before merging.');
        head = old.head.sha;
      }
      if (!head) {
        const base = await clients.content.ref();
        await immutableSource(clients.content, pin.contentCommit, base, options);
        const plan = await contentPlan(clients.content, base, row, options);
        head = await clients.content.createBranch(branch, base, plan.files, `Update guide ${row.guide_id}\n\nContent-SHA256: ${row.content_hash}`, iso(row.reviewed_at));
      }
      await verifyContentBranch(clients.content, head, row, options);
      const pull = await pullFor(clients.content, branch, head, `Guide update: ${row.guide_id}`, `Reviewed guide snapshot.\n\nContent SHA-256: ${row.content_hash}\n\nThis review changes only the guide document and its content manifest. Application publication and private approval evidence are reviewed separately.`);
      const part = providerPart(pull, branch, head);
      return { pipeline: 'content-pin-v1', origin: config.origin, number: part.number, branch, branchSha: head, content: part, phase: 'content_review', merged: false };
    },
    async findReviewNumber(row) {
      configured(); approvedRow(row, config); await repositories();
      const found = await clients.content.pulls(guideContentBranch(row));
      if (!found.length) return null;
      const pull = await clients.content.pull(found[0].number);
      try { verifyPull(pull, clients.content, guideContentBranch(row), pull.head?.sha); } catch { return null; }
      return pull.number;
    },
    async reconcile(row, provider, origin) {
      configured(); approvedRow(row, config); await repositories();
      if (provider.pipeline !== 'content-pin-v1' || provider.origin !== config.origin || provider.number !== provider.content?.number || provider.branchSha !== provider.content?.branchSha) reject('publication_target_mismatch', 'The saved publication reference belongs to a different pipeline.');
      const pull = await clients.content.pull(provider.content.number);
      verifyPull(pull, clients.content, guideContentBranch(row), provider.content.branchSha);
      await verifyContentBranch(clients.content, provider.content.branchSha, row, options);
      if (!pull.merged) {
        await baselineAt(clients.content, await clients.content.ref(), row, options);
        return { state: 'awaiting_merge', provider: { ...provider, phase: 'content_review', merged: false } };
      }
      const content = await verifyContentMerge(clients.content, row, provider.content, options);
      let result;
      try { result = await ensurePin(row, content, provider); }
      catch (error) { error.publication = { ...provider, content, contentMergeSha: content.mergeSha, phase: provider.merged ? 'deployment' : 'website_update', merged: provider.merged === true }; throw error; }
      if (!result.provider.merged) return result;
      try {
      let release;
      try {
        if (new URL(origin).origin !== origin || !origin.startsWith('https://')) return result;
        const response = await (options.fetchImpl || fetch)(`${origin}/data/release.json`, { headers: { 'Cache-Control': 'no-cache' }, redirect: 'error', signal: publicationRequestSignal() });
        if (!response.ok) return result;
        release = await readPublicationJson(response, { maximumBytes: 1_000_000 });
      } catch { return result; }
      if (!SHA.test(release.appCommit || '') || release.commit !== release.appCommit || release.contentOrigin !== config.origin || !SHA.test(release.contentCommit || '') || release.schemaVersion !== 2 || !matchesPublicationProof(release, row.guide_id, receiptFor(row))) return result;
      if (!await clients.app.isDescendant(result.provider.mergeSha, release.appCommit) || !await clients.content.isDescendant(result.provider.contentCommit, release.contentCommit)) return result;
      const releasedPin = await pinAt(clients.app, release.appCommit, config);
      if (releasedPin.contentCommit !== release.contentCommit) return result;
      const liveRows = (await options.approvalRows(Object.keys(release.guides))).filter(candidate => matchesPublicationProof(release, candidate.guide_id, receiptFor(candidate)));
      if (liveRows.length !== Object.keys(release.guides).length || new Set(liveRows.map(candidate => candidate.guide_id)).size !== liveRows.length) return result;
      await verifyGuideReleaseSource({ pin: releasedPin, appCommit: release.appCommit, rows: liveRows, config, clients, ...manifestOptions(options) });
      return { state: 'published', provider: { ...result.provider, phase: 'live', appCommit: release.appCommit, contentCommit: release.contentCommit, deployedCommit: release.appCommit } };
      } catch (error) { error.publication = result.provider; throw error; }
    },
  };
}

/** Read-only build/release proof; neither branch presence nor equal hashes prove a merge. */
export async function verifyGuideReleaseSource({ pin, appCommit, rows, config, clients: suppliedClients, getToken, fetchImpl, expectedBaselines, expectedCatalogBytes } = {}) {
  if (!config || config.origin !== 'guides-v1' || config.pinPath !== 'content/guide-store.json' || !SHA.test(appCommit || '') || !(expectedBaselines instanceof Map) || !expectedCatalogBytes) reject('publication_proof_unavailable', 'Split publication requires complete immutable source proof inputs.');
  const clients = suppliedClients || createGuideGitHubClients(config, { getToken, fetchImpl, readOnly: true });
  const options = { expectedBaselines, expectedCatalogBytes, allowActivation: true }; // Proof of an owner-merged activation is read-only, never activation authority.
  await clients.content.privateRepo({ ownerType: 'Organization' }); await clients.app.privateRepo({ ownerType: 'User' });
  const checkedPin = validateGuidePin(pin, { expectedRepository: identity(config.content) });
  if (checkedPin.mode !== 'active' || !equal(await pinAt(clients.app, appCommit, config), checkedPin) || !await clients.app.isDescendant(appCommit, await clients.app.ref()) || !await clients.content.isDescendant(checkedPin.contentCommit, await clients.content.ref())) reject('publication_proof_mismatch', 'The deployed application and content commits do not match their configured repository histories.');
  const snapshot = await manifestAt(clients.content, checkedPin.contentCommit, options);
  if (guideStoreSha256(snapshot.bytes) !== checkedPin.manifestSha256) reject('manifest_mismatch', 'The deployed content manifest differs from its application pin.');
  const selected = await verifyRowsAtContent(rows, snapshot, checkedPin.contentCommit, clients, config, options, undefined, undefined, checkedPin.guideIds);
  // In v2 the served app still owns non-migrated guides. Their original reviews
  // must really have merged; an exact direct-added file is not publication proof.
  for (const row of rows.filter(row => !checkedPin.guideIds.includes(row.guide_id))) {
    approvedRow(row, config, { requireTarget: false });
    await verifyLegacyMerge(clients.app, row, { config, appCommit });
    if (!equal(await clients.app.jsonAt(appCommit, `content/guides/${row.guide_id}.json`), row.document) || !equal(await clients.app.jsonAt(appCommit, receiptPath(row)), receiptFor(row))) reject('publication_proof_mismatch', 'The deployed legacy guide or private receipt differs from its original merged approval.');
  }
  const pinParts = selected.map(row => rowProvider(row).pin).filter(part => part?.contentCommit === checkedPin.contentCommit);
  if (!pinParts.length) reject('publication_proof_mismatch', 'The content commit lacks its owner-merged application pin review proof.');
  const part = pinParts[0];
  if (pinParts.some(candidate => candidate.number !== part.number || candidate.branch !== part.branch || candidate.branchSha !== part.branchSha || candidate.contentCommit !== part.contentCommit || (candidate.mergeSha && part.mergeSha && candidate.mergeSha !== part.mergeSha))) reject('publication_proof_mismatch', 'The content commit has conflicting application pin proofs.');
  const merged = await verifyAppMerge(clients, part, checkedPin, selected, config, options);
  if (!await clients.app.isDescendant(merged.mergeSha, appCommit)) reject('publication_proof_mismatch', 'The deployed application does not include its owner-merged pin review.');
  for (const row of selected) if (!equal(await clients.app.jsonAt(appCommit, receiptPath(row)), receiptFor(row))) reject('publication_proof_mismatch', 'The deployed application does not include the exact private approval receipt.');
  return { appCommit, contentCommit: checkedPin.contentCommit, contentOrigin: config.origin };
}
