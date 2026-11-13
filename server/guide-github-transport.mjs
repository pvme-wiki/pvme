import { createHash, createSign } from 'node:crypto';
import { PublicationError, publicationRequestSignal } from './github.mjs';
const SHA = /^[a-f0-9]{40}$/;
const reject = (code, message, retryable = false) => { throw new PublicationError(code, message, { retryable }); };
export const guideGitBlobSha = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
const repoIdentity = config => ({ id: Number(config.id), owner: config.owner, repo: config.repo, base: config.base });

/** Bound the encoded response before parsing blobs, trees, or provider metadata. */
export async function readPublicationJson(response, { maximumBytes = 8_388_608 } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 8_388_608) reject('invalid_response_limit', 'The publication response limit is invalid.');
  const declared = response.headers?.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) { await response.body?.cancel().catch(() => {}); reject('provider_response_limit', 'The publication response exceeds its supported size.'); }
  const reader = response.body?.getReader();
  if (!reader) reject('invalid_provider_response', 'The publication response is not a readable body.');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) { await reader.cancel().catch(() => {}); reject('provider_response_limit', 'The publication response exceeds its supported size.'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
  } catch (error) {
    if (error instanceof PublicationError) throw error;
    reject('invalid_provider_response', 'The publication service returned invalid JSON or an interrupted response.', true);
  } finally { reader.releaseLock(); }
}

/** Separate repository-scoped tokens; read-only callers cannot invoke mutations. */
export function createGuideGitHubClients(config, { fetchImpl = fetch, now = () => Date.now(), getToken, readOnly = false } = {}) {
  function client(settings) {
    const repository = repoIdentity(settings), path = `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`;
    let cachedToken, expires = 0;
    const commits = new Map(), trees = new Map(), blobs = new Map(), pendingBlobs = new Map();
    let cachedBlobBytes = 0;
    const bounded = (cache, key, value, maximum) => { cache.set(key, value); if (cache.size > maximum) cache.delete(cache.keys().next().value); };
    async function token() {
      if (getToken) {
        const result = await getToken({ repository, permissions: { contents: readOnly ? 'read' : 'write', pull_requests: readOnly ? 'read' : 'write' } });
        if (typeof result !== 'string' || !result) reject('invalid_installation', 'A repository-scoped GitHub credential is required.');
        return result;
      }
      if (readOnly) reject('publication_proof_unavailable', 'Read-only publication proof credentials are unavailable.');
      if (cachedToken && expires > now() + 60000) return cachedToken;
      if (!settings.appId || !settings.installationId || !settings.privateKey) reject('publication_unconfigured', 'The split publication connection is not configured.');
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ iat: Math.floor(now() / 1000) - 60, exp: Math.floor(now() / 1000) + 540, iss: settings.appId })).toString('base64url');
      const content = `${header}.${payload}`;
      const signature = createSign('RSA-SHA256').update(content).sign(settings.privateKey, 'base64url');
      const result = await request(`/app/installations/${settings.installationId}/access_tokens`, { method: 'POST', auth: `${content}.${signature}`, credentialRequest: true, body: { repository_ids: [repository.id], permissions: { contents: 'write', pull_requests: 'write' } } });
      if (typeof result.token !== 'string' || !result.token || !Number.isFinite(Date.parse(result.expires_at))) reject('invalid_installation', 'The repository-scoped GitHub credential is invalid.');
      cachedToken = result.token; expires = Date.parse(result.expires_at); return cachedToken;
    }
    async function request(target, { method = 'GET', body, optional = false, auth, credentialRequest = false } = {}) {
      if (readOnly && method !== 'GET') reject('read_only_publication_proof', 'Publication verification cannot mutate GitHub.');
      if (!credentialRequest && !target.startsWith(path + '/') && target !== path) reject('repository_mismatch', 'The GitHub operation points outside the configured repository.');
      let response;
      try {
        response = await fetchImpl(`https://api.github.com${target}`, { method, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${auth || await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: publicationRequestSignal() });
      } catch (error) {
        if (error instanceof PublicationError) throw error;
        reject('provider_unavailable', 'The private guide publication connection is unavailable.', true);
      }
      if (optional && response.status === 404) return null;
      if (!response.ok) reject(`provider_${response.status}`, 'The private guide publication service could not complete the operation.', [408, 409, 422, 429].includes(response.status) || response.status >= 500);
      return readPublicationJson(response);
    }
    async function privateRepo({ ownerType } = {}) {
      const result = await request(path);
      if (result.private !== true || Number(result.id) !== repository.id || result.full_name?.toLowerCase() !== `${settings.owner}/${settings.repo}`.toLowerCase() || (ownerType && result.owner?.type !== ownerType)) reject('private_repository_required', 'Publication requires the exact configured private repository and owner.');
      return result;
    }
    async function commit(sha) {
      if (!SHA.test(sha || '')) reject('invalid_commit', 'A publication commit is invalid.');
      if (!commits.has(sha)) bounded(commits, sha, request(`${path}/git/commits/${sha}`).catch(error => { commits.delete(sha); throw error; }), 128);
      const result = await commits.get(sha);
      if (result.sha !== sha || !SHA.test(result.tree?.sha || '') || !Array.isArray(result.parents) || result.parents.some(parent => !SHA.test(parent.sha || ''))) reject('invalid_commit', 'A publication commit could not be verified.');
      return result;
    }
    async function filesAt(sha) {
      const root = (await commit(sha)).tree.sha;
      if (!trees.has(root)) bounded(trees, root, request(`${path}/git/trees/${root}?recursive=1`).catch(error => { trees.delete(root); throw error; }), 8);
      const result = await trees.get(root);
      if (result.truncated || !Array.isArray(result.tree) || result.tree.length > 50000) reject('invalid_tree', 'The publication tree is incomplete or too large.');
      const files = new Map();
      for (const entry of result.tree) {
        if (entry.type === 'tree') continue;
        if (typeof entry.path !== 'string' || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..') || !SHA.test(entry.sha || '') || files.has(entry.path)) reject('invalid_tree', 'The publication tree contains an unsupported path.');
        files.set(entry.path, entry);
      }
      return files;
    }
    async function bytesAt(sha, filename, { optional = false } = {}) {
      const entry = (await filesAt(sha)).get(filename);
      if (!entry) { if (optional) return null; reject('invalid_file', 'A required publication file is missing.'); }
      if (entry.type !== 'blob' || entry.mode !== '100644' || (Number.isFinite(entry.size) && entry.size > 5_500_000)) reject('invalid_file', 'Publication requires bounded regular files.');
      if (blobs.has(entry.sha)) {
        const bytes = blobs.get(entry.sha); blobs.delete(entry.sha); blobs.set(entry.sha, bytes);
        return Buffer.from(bytes);
      }
      if (!pendingBlobs.has(entry.sha)) pendingBlobs.set(entry.sha, (async () => {
        const blob = await request(`${path}/git/blobs/${entry.sha}`);
        if (blob.encoding !== 'base64' || !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > 5_500_000 || typeof blob.content !== 'string') reject('invalid_file', 'A publication file has unsupported encoding or size.');
        const encoded = blob.content.replace(/[\r\n]/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || encoded.length !== Math.ceil(blob.size / 3) * 4) reject('invalid_file', 'A publication blob is not canonical base64.');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded || bytes.length !== blob.size || guideGitBlobSha(bytes) !== entry.sha) reject('invalid_file', 'A publication file differs from its Git object.');
        blobs.set(entry.sha, bytes); cachedBlobBytes += bytes.length;
        while (cachedBlobBytes > 33_554_432) { const oldest = blobs.keys().next().value; cachedBlobBytes -= blobs.get(oldest).length; blobs.delete(oldest); }
        return bytes;
      })().finally(() => pendingBlobs.delete(entry.sha)));
      return Buffer.from(await pendingBlobs.get(entry.sha));
    }
    async function jsonAt(sha, filename, options) {
      const bytes = await bytesAt(sha, filename, options);
      if (bytes === null) return null;
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { reject('invalid_file', 'A publication file is invalid JSON or UTF-8.'); }
    }
    async function ref(branch = settings.base, { optional = false } = {}) {
      const value = await request(`${path}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { optional });
      if (value && !SHA.test(value.object?.sha || '')) reject('invalid_commit', 'A publication branch has an invalid commit.');
      return value?.object.sha || null;
    }
    async function isDescendant(base, head) {
      if (!SHA.test(base || '') || !SHA.test(head || '')) reject('invalid_commit', 'Publication ancestry requires exact commits.');
      if (base === head) return true;
      const comparison = await request(`${path}/compare/${base}...${head}`);
      return comparison.status === 'ahead' && comparison.merge_base_commit?.sha === base;
    }
    async function pull(number) {
      if (!Number.isSafeInteger(number) || number < 1) reject('invalid_pull_request', 'A publication review number is invalid.');
      return request(`${path}/pulls/${number}`);
    }
    async function pulls(branch) {
      const values = await request(`${path}/pulls?${new URLSearchParams({ state: 'all', head: `${settings.owner}:${branch}`, base: settings.base, per_page: '100' })}`);
      if (!Array.isArray(values) || values.length > 1) reject('pull_request_conflict', 'The publication review is ambiguous.');
      return values;
    }
    async function createBranch(branch, base, files, message, date) {
      const parent = await commit(base), entries = [];
      for (const [filename, value] of files) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const blob = await request(`${path}/git/blobs`, { method: 'POST', body: { content: bytes.toString('base64'), encoding: 'base64' } });
        if (blob.sha !== guideGitBlobSha(bytes)) reject('invalid_provider_response', 'GitHub returned a different publication blob.');
        entries.push({ path: filename, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const tree = await request(`${path}/git/trees`, { method: 'POST', body: { base_tree: parent.tree.sha, tree: entries } });
      const author = { name: 'PvME editor', email: 'pvme-editor@users.noreply.github.com', date };
      const created = await request(`${path}/git/commits`, { method: 'POST', body: { message, tree: tree.sha, parents: [base], author, committer: author } });
      if (!SHA.test(created.sha || '')) reject('invalid_provider_response', 'GitHub returned an invalid publication commit.');
      try { await request(`${path}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: created.sha } }); }
      catch (error) { if (!['provider_422', 'provider_409'].includes(error.code)) throw error; }
      return ref(branch);
    }
    async function createPull(branch, title, body) {
      return request(`${path}/pulls`, { method: 'POST', body: { title, head: branch, base: settings.base, draft: true, body } });
    }
    return { repository, privateRepo, commit, filesAt, bytesAt, jsonAt, ref, isDescendant, pull, pulls, createBranch, createPull };
  }
  return { content: client(config.content), app: client(config.app) };
}
