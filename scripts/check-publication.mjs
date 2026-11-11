import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHostedContent } from './hosted-content.mjs';
export async function checkProductionPublication(root, published, expectedBaselines, env = process.env) {
  if (env.VERCEL_ENV !== 'production') return { verifiedCount: 0 };
  if (!env.DATABASE_URL) throw Error('Production publication requires its approval database. Deployment stopped.');
  const { createDatabase } = await import('../server/db.mjs');
  const { verifyPublicationGate } = await import('../server/publication-gate.mjs');
  let db;
  try {
    db = createDatabase({ databaseUrl: env.DATABASE_URL });
    return await verifyPublicationGate(db, published, { expectedBaselines });
  } catch (error) {
    // A build failure must never print a database URL or operational secret.
    throw Error(error?.name === 'PublicationGateError' ? error.message : 'Production publication could not verify the approval database. Deployment stopped.');
  } finally { if (db) await db.close().catch(() => {}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const hosted = loadHostedContent(root, process.env.VERCEL_GIT_COMMIT_SHA);
  const result = await checkProductionPublication(root, hosted.published, hosted.baseline);
  console.log(`Publication authority check completed for ${result.verifiedCount} guide overlays.`);
}
