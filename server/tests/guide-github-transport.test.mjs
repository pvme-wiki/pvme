import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuideGitHubClients, guideGitBlobSha, readPublicationJson } from '../guide-github-transport.mjs';
import { withProviderBudget } from '../github.mjs';
import { config as signing } from './github-contract.mjs';
const config = { content: { ...signing, id: 100, owner: 'guide-org', repo: 'private-guides' }, app: { ...signing, id: 200, owner: 'owner', repo: 'app' } };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
test('publication JSON rejects declared and streamed oversize bodies before parsing', async () => {
  await assert.rejects(readPublicationJson(new Response('{}', { headers: { 'Content-Length': '129' } }), { maximumBytes: 128 }), error => error.code === 'provider_response_limit');
  let reads = 0, cancelled = false;
  const stream = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(64)); }, cancel() { cancelled = true; } });
  await assert.rejects(readPublicationJson(new Response(stream), { maximumBytes: 128 }), error => error.code === 'provider_response_limit');
  assert.equal(cancelled, true); assert.ok(reads <= 4);
  await assert.rejects(readPublicationJson(new Response(Uint8Array.of(255))), error => error.code === 'invalid_provider_response');
});
test('GitHub requests honor the shared provider budget before touching the network', async () => {
  let requests = 0;
  const clients = createGuideGitHubClients(config, { getToken: async () => 'read-token', readOnly: true, fetchImpl: async () => { requests++; return json({}); } });
  await assert.rejects(withProviderBudget(() => clients.content.privateRepo(), 50), error => error.code === 'provider_timeout' && error.retryable);
  assert.equal(requests, 0);
});
test('publication App mints repository-ID scoped write tokens and never sends its key', async () => {
  const calls = [];
  const clients = createGuideGitHubClients(config, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/access_tokens')) return json({ token: 'scoped-token', expires_at: new Date(Date.now() + 3600000).toISOString() });
    return json({ private: true, id: 100, full_name: 'guide-org/private-guides', owner: { type: 'Organization' } });
  } });
  await clients.content.privateRepo({ ownerType: 'Organization' });
  const mint = calls[0]; assert.deepEqual(JSON.parse(mint.options.body), { repository_ids: [100], permissions: { contents: 'write', pull_requests: 'write' } });
  assert.match(mint.options.headers.Authorization, /^Bearer ey/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer scoped-token');
  assert.equal(JSON.stringify(calls).includes(signing.privateKey), false);
  assert.ok(calls.every(call => call.options.redirect === 'error' && call.options.signal instanceof AbortSignal));
});
test('immutable commit cache does not retain transient provider failures', async () => {
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40); let requests = 0;
  const clients = createGuideGitHubClients(config, { getToken: async () => 'read', readOnly: true, fetchImpl: async () => { requests++; return requests === 1 ? new Response('{}', { status: 500 }) : json({ sha, tree: { sha: tree }, parents: [] }); } });
  await assert.rejects(clients.content.commit(sha), error => error.code === 'provider_500');
  assert.equal((await clients.content.commit(sha)).sha, sha); assert.equal(requests, 2);
});
test('blob reads require regular files, exact Git hash and canonical bounded base64', async () => {
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40), bytes = Buffer.from('{}'), blobSha = guideGitBlobSha(bytes);
  for (const content of [bytes.toString('base64'), bytes.toString('base64') + '\n', 'e30=!', 'e30=\t']) {
    const clients = createGuideGitHubClients(config, { getToken: async () => 'read', readOnly: true, fetchImpl: async url => {
      if (url.includes('/git/commits/')) return json({ sha, tree: { sha: tree }, parents: [] });
      if (url.includes('/git/trees/')) return json({ truncated: false, tree: [{ path: 'manifest.json', mode: '100644', type: 'blob', sha: blobSha, size: bytes.length }] });
      return json({ encoding: 'base64', size: bytes.length, content });
    } });
    if (/!|\t/.test(content)) await assert.rejects(clients.content.bytesAt(sha, 'manifest.json'), error => error.code === 'invalid_file');
    else assert.deepEqual(await clients.content.bytesAt(sha, 'manifest.json'), bytes);
  }
});

test('immutable verified blob reads share one fetch and never expose mutable cached buffers', async () => {
  const sha = 'a'.repeat(40), tree = 'b'.repeat(40), bytes = Buffer.from('{}'), blobSha = guideGitBlobSha(bytes); let blobReads = 0;
  const clients = createGuideGitHubClients(config, { getToken: async () => 'read', readOnly: true, fetchImpl: async url => {
    if (url.includes('/git/commits/')) return json({ sha, tree: { sha: tree }, parents: [] });
    if (url.includes('/git/trees/')) return json({ truncated: false, tree: [{ path: 'manifest.json', mode: '100644', type: 'blob', sha: blobSha, size: bytes.length }] });
    blobReads++; return json({ encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
  } });
  const [first, second] = await Promise.all([clients.content.bytesAt(sha, 'manifest.json'), clients.content.bytesAt(sha, 'manifest.json')]);
  assert.equal(blobReads, 1); first[0] = 0;
  assert.deepEqual(second, bytes); assert.deepEqual(await clients.content.bytesAt(sha, 'manifest.json'), bytes); assert.equal(blobReads, 1);
});
