import { createPrivateKey } from 'node:crypto';

const fields = ['GUIDE_STORE_STAGE', 'GUIDE_STORE_REPOSITORY_ID', 'GUIDE_STORE_OWNER', 'GUIDE_STORE_REPO', 'GUIDE_STORE_BASE_BRANCH', 'GUIDE_STORE_APP_ID', 'GUIDE_STORE_INSTALLATION_ID', 'GUIDE_STORE_APP_PRIVATE_KEY', 'GUIDE_STORE_WEBHOOK_SECRET', 'GITHUB_REPOSITORY_ID'];
const positive = value => /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value)) && Number(value) > 0;
export function loadGuideStoreConfig(env, legacy) {
  if (!fields.some(key => env[key])) return { config: null, errors: [] };
  const errors = [];
  if (!legacy || fields.some(key => !env[key])) errors.push('Guide-store staging requires both complete private repository bindings.');
  if (!['shadow', 'active'].includes(env.GUIDE_STORE_STAGE)) errors.push('GUIDE_STORE_STAGE must be shadow or active.');
  for (const key of ['GUIDE_STORE_REPOSITORY_ID', 'GUIDE_STORE_APP_ID', 'GUIDE_STORE_INSTALLATION_ID', 'GITHUB_REPOSITORY_ID']) if (!positive(env[key])) errors.push(`${key} must be a positive repository or installation identifier.`);
  for (const key of ['GUIDE_STORE_OWNER', 'GUIDE_STORE_REPO']) if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(env[key] || '')) errors.push(`${key} is invalid.`);
  const branch = env.GUIDE_STORE_BASE_BRANCH || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_/-]{0,150}$/.test(branch) || branch.includes('//') || branch.split('/').some(part => !part)) errors.push('GUIDE_STORE_BASE_BRANCH is invalid.');
  if ((env.GUIDE_STORE_WEBHOOK_SECRET || '').length < 32) errors.push('Guide-store webhook secret is incomplete.');
  let privateKey;
  try {
    privateKey = (env.GUIDE_STORE_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa') throw Error();
  } catch { errors.push('Guide-store publisher requires its scoped RSA App key.'); }
  if (legacy && `${legacy.owner}/${legacy.repo}`.toLowerCase() === `${env.GUIDE_STORE_OWNER}/${env.GUIDE_STORE_REPO}`.toLowerCase()) errors.push('Guide storage and application repositories must be distinct.');
  if (errors.length) return { config: null, errors };
  return { errors: [], config: {
    stage: env.GUIDE_STORE_STAGE, origin: 'guides-v1', pinPath: 'content/guide-store.json',
    app: { ...legacy, id: Number(env.GITHUB_REPOSITORY_ID) },
    content: { id: Number(env.GUIDE_STORE_REPOSITORY_ID), owner: env.GUIDE_STORE_OWNER, repo: env.GUIDE_STORE_REPO, base: branch, appId: env.GUIDE_STORE_APP_ID, installationId: env.GUIDE_STORE_INSTALLATION_ID, privateKey, webhookSecret: env.GUIDE_STORE_WEBHOOK_SECRET },
  } };
}
