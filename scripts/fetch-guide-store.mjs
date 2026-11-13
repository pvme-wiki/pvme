import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ContentStoreError, GUIDE_STORE_LIMITS, GUIDE_STORE_MANIFEST, guideStoreSha256,
  guideStorePaths, isGuideStorePath, validateGuidePin, validateGuideManifest, validateGuideStore,
} from '../server/content-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHA = /^[a-f0-9]{40}$/;
const fail = (code, message) => { throw new ContentStoreError(code, message); };
async function boundedJson(response, maximum) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) fail('response_limit', 'The guide service response exceeds its bounded size.');
  let text = '', bytes = 0;
  if (!response.body) fail('invalid_response', 'The guide service returned an empty response.');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > maximum) { await reader.cancel(); fail('response_limit', 'The guide service response exceeds its bounded size.'); } text += decoder.decode(chunk.value, { stream: true }); }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) { if (error instanceof ContentStoreError) throw error; fail('invalid_response', 'The guide service returned invalid JSON or UTF-8.'); }
  finally { reader.releaseLock(); }
}
/** Fetch a pinned, private, data-only tree. Every provider request is a GET. */
export async function fetchGuideStore({ pin, expectedBaselines, expectedCatalogBytes, expectedRepository, getToken, fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  const checkedPin = validateGuidePin(pin, { expectedRepository });
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) fail('invalid_timeout', 'Pinned guide retrieval requires a bounded time budget.');
  if (typeof getToken !== 'function' || typeof fetchImpl !== 'function') fail('credentials_unavailable', 'A read-only guide connection is required.');
  const start = Date.now(); let access, tokenTimer;
  try {
    access = await Promise.race([
      Promise.resolve().then(() => getToken({ repository: checkedPin.repository, permissions: { contents: 'read' } })),
      new Promise((_, reject) => { tokenTimer = setTimeout(() => reject(new Error('timeout')), Math.min(10000, timeoutMs)); tokenTimer.unref?.(); }),
    ]);
  } catch { fail('credentials_unavailable', 'The read-only guide connection could not be established.'); }
  finally { clearTimeout(tokenTimer); }
  if (typeof access !== 'string' || !access || access !== access.trim() || /[\r\n\u0000]/.test(access)) fail('credentials_unavailable', 'The read-only guide connection is invalid.');
  const { repository, contentCommit } = checkedPin;
  const repoPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  async function request(suffix, maximum = 1_000_000) {
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining < 1) fail('fetch_timeout', 'Pinned guide retrieval exceeded its time budget.');
    let response;
    try { response = await fetchImpl(`https://api.github.com${repoPath}${suffix}`, { method: 'GET', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${access}` }, redirect: 'error', signal: AbortSignal.timeout(Math.min(10000, remaining)) }); }
    catch { fail('provider_unavailable', 'The pinned guide repository could not be read.'); }
    if (!response.ok || response.redirected) fail('provider_unavailable', 'The pinned guide repository could not be read.');
    return boundedJson(response, maximum);
  }
  const repo = await request('');
  if (repo.id !== repository.id || repo.private !== true || repo.full_name?.toLowerCase() !== `${repository.owner}/${repository.repo}`.toLowerCase()) fail('repository_mismatch', 'The pinned guide repository identity or privacy does not match.');
  const refPath = repository.base.split('/').map(encodeURIComponent).join('/');
  const base = await request(`/git/ref/heads/${refPath}`);
  if (base.ref !== `refs/heads/${repository.base}` || base.object?.type !== 'commit' || !SHA.test(base.object.sha || '')) fail('invalid_base', 'The configured guide base branch could not be verified.');
  const commit = await request(`/git/commits/${contentCommit}`);
  if (commit.sha !== contentCommit || !SHA.test(commit.tree?.sha || '')) fail('invalid_commit', 'The pinned guide commit could not be verified.');
  if (contentCommit !== base.object.sha) {
    const compare = await request(`/compare/${contentCommit}...${base.object.sha}`, 2_000_000);
    if (!['ahead', 'identical'].includes(compare.status) || compare.base_commit?.sha !== contentCommit || compare.merge_base_commit?.sha !== contentCommit) fail('unmerged_commit', 'The pinned guide commit is not a merged ancestor of the configured base.');
  }
  const tree = await request(`/git/trees/${commit.tree.sha}?recursive=1`, 2_000_000);
  if (tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > GUIDE_STORE_LIMITS.files + 2) fail('invalid_tree', 'The pinned guide tree is incomplete or exceeds its file inventory limit.');
  const blobs = new Map(), seenEntries = new Set(); let declaredBytes = 0;
  for (const entry of tree.tree) {
    if (!entry || typeof entry.path !== 'string' || !SHA.test(entry.sha || '')) fail('invalid_tree', 'The pinned guide tree contains an invalid entry.');
    if (seenEntries.has(entry.path)) fail('invalid_tree', 'The pinned guide tree contains a duplicate path.'); seenEntries.add(entry.path);
    if (entry.type === 'tree' && entry.mode === '040000' && ['baselines', 'guides'].includes(entry.path)) continue;
    if (entry.type !== 'blob' || entry.mode !== '100644' || !isGuideStorePath(entry.path) || blobs.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > GUIDE_STORE_LIMITS.fileBytes) fail('unexpected_files', 'The pinned guide tree contains an unsupported path, mode or file size.');
    declaredBytes += entry.size; if (declaredBytes > GUIDE_STORE_LIMITS.totalBytes) fail('payload_limit', 'The pinned guide tree exceeds its aggregate payload size limit.');
    blobs.set(entry.path, entry);
  }
  if (!blobs.has(GUIDE_STORE_MANIFEST)) fail('missing_manifest', 'The pinned guide tree has no manifest.');
  let totalBytes = 0;
  async function blob(file) {
    const entry = blobs.get(file); if (!entry) fail('missing_file', 'A declared guide file is absent from the pinned tree.');
    const value = await request(`/git/blobs/${entry.sha}`, Math.ceil(entry.size * 1.5) + 20000);
    if (value.sha !== entry.sha || value.encoding !== 'base64' || value.size !== entry.size || typeof value.content !== 'string' || /[^A-Za-z0-9+/=\r\n]/.test(value.content)) fail('invalid_blob', 'A pinned guide blob has an invalid representation.');
    const encoded = value.content.replace(/[\r\n]/g, ''), bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== entry.size || bytes.toString('base64') !== encoded || createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex') !== entry.sha) fail('invalid_blob', 'A pinned guide blob differs from its Git object.');
    totalBytes += bytes.length; if (totalBytes > GUIDE_STORE_LIMITS.totalBytes) fail('payload_limit', 'The pinned guide payload exceeds its aggregate size limit.');
    return bytes;
  }
  const manifestBytes = await blob(GUIDE_STORE_MANIFEST);
  if (manifestBytes.length > GUIDE_STORE_LIMITS.manifestBytes || guideStoreSha256(manifestBytes) !== checkedPin.manifestSha256) fail('manifest_mismatch', 'The pinned guide manifest digest does not match.');
  let parsedManifest;
  try { parsedManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { fail('invalid_manifest', 'The pinned guide manifest is invalid.'); }
  const { manifest } = validateGuideManifest(parsedManifest, { expectedBaselines, expectedCatalogBytes, guideIds: checkedPin.guideIds });
  const paths = guideStorePaths(manifest);
  if (JSON.stringify([...blobs.keys()].sort()) !== JSON.stringify(paths)) fail('unexpected_files', 'The pinned guide tree differs from the complete manifest inventory.');
  const files = new Map([[GUIDE_STORE_MANIFEST, manifestBytes]]), pending = paths.filter(file => file !== GUIDE_STORE_MANIFEST);
  let cursor = 0, stopped = false;
  async function worker() { try { for (;;) { if (stopped) return; const index = cursor++; if (index >= pending.length) return; const file = pending[index]; files.set(file, await blob(file)); } } catch (error) { stopped = true; throw error; } }
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
  const validated = validateGuideStore({ pin: checkedPin, manifestBytes, files, expectedBaselines, expectedCatalogBytes, expectedRepository });
  return { ...validated, proof: { repositoryId: repository.id, contentCommit, treeSha: commit.tree.sha, base: repository.base, baseHead: base.object.sha, files: files.size, bytes: totalBytes } };
}
function writeCache(store, output) {
  const runtime = path.resolve(ROOT, '.runtime'), destination = path.resolve(output);
  if (!destination.startsWith(runtime + path.sep) || fs.existsSync(destination)) fail('invalid_output', 'Choose a new output directory inside this worktree’s ignored .runtime directory.');
  let current = ROOT;
  for (const part of path.relative(ROOT, destination).split(path.sep)) { current = path.join(current, part); if (fs.existsSync(current) && !fs.lstatSync(current).isDirectory()) fail('invalid_output', 'Guide cache output cannot traverse symbolic links or non-directories.'); }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const [file, bytes] of store.files) { const target = path.join(destination, 'payload', file); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); }
  fs.writeFileSync(path.join(destination, 'pin.json'), JSON.stringify(store.pin, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(destination, 'fetch-audit.json'), JSON.stringify(store.proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); if (![2, 4].includes(args.length) || args[0] !== '--pin' || (args.length === 4 && args[2] !== '--output')) fail('invalid_arguments', 'Use --pin PATH for a read-only dry run, optionally --output PATH under .runtime.');
    if (!fs.lstatSync(args[1]).isFile()) fail('invalid_pin', 'The content pin must be a regular file.');
    const pin = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    const { loadSeedDocuments } = await import('../server/manage.mjs');
    const baselines = await loadSeedDocuments();
    const { createGuideReadTokenProvider } = await import('../server/guide-store-read-auth.mjs');
    const store = await fetchGuideStore({ pin, expectedBaselines: new Map(baselines.map(item => [item.id, item.document])), expectedCatalogBytes: fs.readFileSync(path.join(ROOT, 'editor/content/catalog.json')), getToken: createGuideReadTokenProvider(process.env) });
    if (args.length === 4) writeCache(store, args[3]);
    console.log(JSON.stringify({ dryRun: args.length === 2, ...store.proof, baselineCount: store.baseline.size, overlayCount: store.guides.size }));
  } catch (error) { console.error(error instanceof ContentStoreError ? error.message : 'Pinned guide retrieval failed. No remote changes were made.'); process.exitCode = 1; }
}
