import fs from 'node:fs';
import path from 'node:path';
import { loadHostedContent, loadGuideBaselines } from './hosted-content.mjs';

// The pin is reviewed with the app commit. Branch names and mutable environment
// variables never select content; credentials only authorize that exact read.
export async function loadBuildContent(root, appCommit, { env = process.env, fetchStore = null } = {}) {
  const pinPath = path.join(root, 'content/guide-store.json');
  if (!fs.existsSync(pinPath)) return loadHostedContent(root, appCommit);
  if (!fs.lstatSync(pinPath).isFile() || fs.statSync(pinPath).size > 128 * 1024) throw Error('Invalid guide-store pin file');
  const { validateGuidePin } = await import('../server/content-store.mjs');
  let pin;
  try { pin = validateGuidePin(JSON.parse(fs.readFileSync(pinPath, 'utf8'))); }
  catch { throw Error('The reviewed guide-store pin is invalid. Deployment stopped.'); }
  const expectedRepository = {
    id: Number(env.GUIDE_STORE_REPOSITORY_ID), owner: env.GUIDE_STORE_OWNER,
    repo: env.GUIDE_STORE_REPO, base: env.GUIDE_STORE_BASE_BRANCH,
  };
  try { validateGuidePin(pin, { expectedRepository }); }
  catch { throw Error('Guide-store repository binding is unavailable or mismatched. Deployment stopped.'); }
  const baseline = loadGuideBaselines(root);
  const expectedCatalogBytes = fs.readFileSync(path.join(root, 'editor/content/catalog.json'));
  const { createGuideReadTokenProvider } = await import('../server/guide-store-read-auth.mjs');
  const getToken = createGuideReadTokenProvider(env);
  let guideStore;
  try {
    const fetcher = fetchStore || (await import('./fetch-guide-store.mjs')).fetchGuideStore;
    guideStore = await fetcher({ pin, expectedBaselines: baseline, expectedCatalogBytes, getToken });
  } catch { throw Error('Pinned private guide content could not be verified. Deployment stopped.'); }
  // Shadow still validates the entire candidate store; output remains legacy.
  return loadHostedContent(root, appCommit, { guideStore });
}
