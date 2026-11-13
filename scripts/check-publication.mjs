import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadBuildContent } from './load-build-content.mjs';
export async function checkProductionPublication(root, published, expectedBaselines, env = process.env, source = {}) {
  if (env.VERCEL_ENV !== 'production') return { verifiedCount: 0 };
  if (!env.DATABASE_URL) throw Error('Production publication requires its approval database. Deployment stopped.');
  const { createDatabase } = await import('../server/db.mjs');
  const { verifyPublicationGate } = await import('../server/publication-gate.mjs');
  let db;
  try {
    db = createDatabase({ databaseUrl: env.DATABASE_URL });
    const verifySource = source.guideStore?.pin.mode === 'active' ? async proof => {
      const { verifyGuideReleaseSource } = await import('../server/github-guide-store.mjs');
      const repository = { id: Number(env.GITHUB_REPOSITORY_ID), owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, base: env.GITHUB_BASE_BRANCH };
      const content = { id: Number(env.GUIDE_STORE_REPOSITORY_ID), owner: env.GUIDE_STORE_OWNER, repo: env.GUIDE_STORE_REPO, base: env.GUIDE_STORE_BASE_BRANCH };
      repository.installationId = env.GITHUB_INSTALLATION_ID;
      content.installationId = env.GUIDE_STORE_INSTALLATION_ID;
      const config = { origin: 'guides-v1', pinPath: 'content/guide-store.json', app: repository, content };
      const { createGuideReadTokenProvider } = await import('../server/guide-store-read-auth.mjs');
      const getToken = createGuideReadTokenProvider(env);
      return verifyGuideReleaseSource({ ...proof, config, getToken, expectedBaselines, expectedCatalogBytes: fs.readFileSync(path.join(root, 'editor/content/catalog.json')) });
    } : null;
    return await verifyPublicationGate(db, published, { expectedBaselines, ...source, verifySource });
  } catch (error) {
    // A build failure must never print a database URL or operational secret.
    throw Error(error?.name === 'PublicationGateError' ? error.message : 'Production publication could not verify the approval database. Deployment stopped.');
  } finally { if (db) await db.close().catch(() => {}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const hosted = await loadBuildContent(root, process.env.VERCEL_GIT_COMMIT_SHA);
  const result = await checkProductionPublication(root, hosted.published, hosted.baseline, process.env, { guideStore: hosted.guideStore, appCommit: hosted.release.appCommit });
  console.log(`Publication authority check completed for ${result.verifiedCount} guide overlays.`);
}
