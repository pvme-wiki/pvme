// Protected operator entry point. Never imported by a request handler.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db.mjs';
import { documentHash } from './core.mjs';
import { loadBuildContent } from '../scripts/load-build-content.mjs';
import { validatePublicationTarget, samePublicationTarget, handoffGuidePublication } from './publication-targets.mjs';
const ROOT = path.resolve(import.meta.dirname, '..');
export async function prepareGuideHandoff(db, root, { guideId, reason, env = process.env, appCommit = env.VERCEL_GIT_COMMIT_SHA, fetchStore } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(guideId || '') || typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw Error('A guide ID and bounded handoff reason are required.');
  if (env.GUIDE_STORE_STAGE !== 'active') throw Error('Operator handoff requires explicit active-stage configuration after staged review.');
  const legacy = validatePublicationTarget({ pipeline: 'legacy-v1', origin: 'legacy-v1', repository: { id: env.GITHUB_REPOSITORY_ID, owner: env.GITHUB_OWNER, repo: env.GITHUB_REPO, base: env.GITHUB_BASE_BRANCH }, installationId: env.GITHUB_INSTALLATION_ID });
  const settings = (await db.query('SELECT legacy_target FROM publication_migration_settings WHERE singleton=true')).rows[0];
  if (!settings || !samePublicationTarget(settings.legacy_target, legacy)) throw Error('The operator binding does not match the immutable original repository.');
  const hosted = await loadBuildContent(root, appCommit, { env, fetchStore });
  const store = hosted.guideStore;
  if (!store) throw Error('A reviewed shadow or active guide-store pin is required before handoff.');
  const target = validatePublicationTarget({ pipeline: 'content-pin-v1', origin: store.pin.origin, repository: store.pin.repository, installationId: env.GUIDE_STORE_INSTALLATION_ID });
  const current = (await db.query('SELECT g.revision,r.content_hash FROM guides g JOIN guide_revisions r ON r.guide_id=g.id AND r.revision=g.revision WHERE g.id=$1', [guideId])).rows[0];
  const remote = store.guides.get(guideId), document = remote?.document || store.baseline.get(guideId);
  const revision = remote?.revision || 1;
  if (!current || !document || document.id !== guideId || revision !== current.revision || documentHash(document) !== current.content_hash) throw Error('The immutable guide-store snapshot differs from the current editing revision.');
  const pending = (await db.query(`SELECT count(*)::int AS count FROM submissions s LEFT JOIN publication_jobs j ON j.submission_id=s.id WHERE s.guide_id=$1 AND COALESCE(s.publication_target->>'pipeline','legacy-v1')='legacy-v1' AND s.status NOT IN ('published','rejected') AND NOT EXISTS (SELECT 1 FROM submissions replacement JOIN audit_events e ON e.subject_id=s.id::text AND e.action='submission.resubmitted' WHERE replacement.id::text=j.provider->>'replacementId' AND replacement.guide_id=s.guide_id AND e.data->>'replacementId'=replacement.id::text)`, [guideId])).rows[0];
  if (pending.count) throw Error('Resolve all remaining legacy work for this guide before handoff.');
  const plan = { guideId, target, expectedRevision: current.revision, expectedHash: current.content_hash, contentCommit: store.pin.contentCommit, reason: reason.trim() };
  // Capture already validated immutable bytes; the DB helper rechecks the local
  // revision and pending work under lock before changing authority.
  return { plan, apply: () => handoffGuidePublication(db, { ...plan, verifyContent: async proof => proof.guideId === guideId && proof.contentCommit === store.pin.contentCommit && proof.expectedRevision === revision && proof.contentHash === documentHash(document) }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let db;
  try {
    const args = process.argv.slice(2), apply = args[0] === '--apply';
    if (apply) args.shift();
    if (args.length !== 2 || !process.env.MIGRATION_DATABASE_URL) throw Error('Use [--apply] GUIDE_ID REASON with protected operator configuration.');
    db = createDatabase({ databaseUrl: process.env.MIGRATION_DATABASE_URL });
    const prepared = await prepareGuideHandoff(db, ROOT, { guideId: args[0], reason: args[1] });
    const result = apply ? await prepared.apply() : { dryRun: true, ...prepared.plan };
    console.log(JSON.stringify(result));
  } catch { console.error('Guide handoff stopped. Verify staged approval, exact repository bindings, immutable pin, protected database and drained legacy work. No provider error or credential is printed.'); process.exitCode = 1; }
  finally { if (db) await db.close().catch(() => {}); }
}
