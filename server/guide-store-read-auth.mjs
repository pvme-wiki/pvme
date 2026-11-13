import { createPrivateKey, createSign } from 'node:crypto';
import { validateGuideRepository } from './content-store.mjs';
import { canonical } from './core.mjs';

// These must be read-only Apps, separate from the publication-write identity.
// No credential or provider response is included in an operational error.
export function createGuideReadTokenProvider(env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const definitions = [
    { prefix: 'GUIDE_STORE_READ', repository: { id: Number(env.GUIDE_STORE_REPOSITORY_ID), owner: env.GUIDE_STORE_OWNER, repo: env.GUIDE_STORE_REPO, base: env.GUIDE_STORE_BASE_BRANCH } },
    { prefix: 'GUIDE_STORE_APP_READ', repository: { id: Number(env.GITHUB_REPOSITORY_ID), owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, base: env.GITHUB_BASE_BRANCH } },
  ];
  const caches = new Map();
  async function request(route, authorization, body) {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${authorization}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw Error();
      return await response.json();
    } catch { throw Error('Scoped guide read authentication is unavailable.'); }
  }
  return async ({ repository, permissions = { contents: 'read' } }) => {
    validateGuideRepository(repository);
    if (Object.entries(permissions).some(([name, value]) => !['contents', 'pull_requests'].includes(name) || value !== 'read')) throw Error('Guide read authentication cannot grant write access.');
    const definition = definitions.find(item => canonical(item.repository) === canonical(repository));
    if (!definition) throw Error('Unknown guide read repository.');
    const key = canonical(repository), previous = caches.get(key);
    if (previous && previous.expires > now() + 60_000) return previous.token;
    const appId = env[`${definition.prefix}_APP_ID`], installationId = env[`${definition.prefix}_INSTALLATION_ID`];
    let privateKey;
    try {
      if (!/^[1-9][0-9]*$/.test(appId || '') || !/^[1-9][0-9]*$/.test(installationId || '')) throw Error();
      privateKey = createPrivateKey((env[`${definition.prefix}_PRIVATE_KEY`] || '').replace(/\\n/g, '\n'));
      if (privateKey.asymmetricKeyType !== 'rsa') throw Error();
    } catch { throw Error('The selected-repository read App is not configured.'); }
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: Math.floor(now() / 1000) - 60, exp: Math.floor(now() / 1000) + 540, iss: appId })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64url')}`;
    const installation = await request(`/app/installations/${installationId}`, jwt);
    const allowedPermissions = value => value && value.contents === 'read' && value.pull_requests === 'read' && Object.entries(value).every(([name, level]) => ['contents', 'pull_requests', 'metadata'].includes(name) && level === 'read');
    if (String(installation.id) !== installationId || String(installation.app_id) !== appId || installation.account?.login?.toLowerCase() !== repository.owner.toLowerCase() || installation.repository_selection !== 'selected' || !allowedPermissions(installation.permissions) || installation.suspended_at) throw Error('Guide read App installation does not match the selected private repository.');
    const result = await request(`/app/installations/${installationId}/access_tokens`, jwt, { repository_ids: [repository.id], permissions: { contents: 'read', pull_requests: 'read' } });
    const expires = Date.parse(result.expires_at);
    if (typeof result.token !== 'string' || !result.token || !Number.isFinite(expires) || expires <= now() + 60_000 || expires > now() + 3_660_000 || !allowedPermissions(result.permissions) || result.repository_selection !== 'selected' || !Array.isArray(result.repositories) || result.repositories.length !== 1 || result.repositories[0].id !== repository.id || result.repositories[0].private !== true || result.repositories[0].full_name?.toLowerCase() !== `${repository.owner}/${repository.repo}`.toLowerCase()) throw Error('Guide read token is not restricted to its selected private repository.');
    caches.set(key, { token: result.token, expires });
    return result.token;
  };
}
