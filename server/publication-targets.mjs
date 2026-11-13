import { randomUUID } from 'node:crypto';
import { canonical } from './core.mjs';
import { approvalEventsSql } from './approval.mjs';
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const ORIGIN = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const digits = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9][0-9]*$/.test(String(value));
export class PublicationTargetError extends Error {
  constructor(code, message, { retryable = false } = {}) { super(message); this.name = 'PublicationTargetError'; this.code = code; this.retryable = retryable; }
}
const reject = (code, message, options) => { throw new PublicationTargetError(code, message, options); };
export function validatePublicationTarget(value) {
  if (!exactKeys(value, ['pipeline','origin','repository','installationId']) || !['legacy-v1','content-pin-v1'].includes(value.pipeline) || !ORIGIN.test(value.origin || '') ||
      !exactKeys(value.repository, ['id','owner','repo','base']) || !digits(value.repository.id) || !digits(value.installationId) ||
      !NAME.test(value.repository.owner || '') || !NAME.test(value.repository.repo || '') ||
      !/^[A-Za-z0-9][A-Za-z0-9_/-]{0,150}$/.test(value.repository.base || '') || value.repository.base.includes('//') || value.repository.base.endsWith('/')) {
    reject('publication_target_invalid', 'The publication destination is invalid. A maintainer must check its configuration.');
  }
  return { pipeline: value.pipeline, origin: value.origin, repository: { id: String(value.repository.id), owner: value.repository.owner, repo: value.repository.repo, base: value.repository.base }, installationId: String(value.installationId) };
}
export function samePublicationTarget(a, b) {
  try { return canonical(validatePublicationTarget(a)) === canonical(validatePublicationTarget(b)); } catch { return false; }
}
export function publicationTargetDescriptor(entry) {
  return validatePublicationTarget({ pipeline: entry?.pipeline, origin: entry?.origin, repository: entry?.repository, installationId: entry?.installationId });
}
export function trustedPublicationTarget(target, registry = []) {
  const normalized = validatePublicationTarget(target);
  const entries = registry instanceof Map ? [...registry.values()] : registry;
  if (!Array.isArray(entries)) reject('publication_target_unknown', 'The publication destination is not configured.');
  const descriptor = entries.find(entry => samePublicationTarget(normalized, publicationTargetDescriptor(entry)));
  if (!descriptor) reject('publication_target_unknown', 'This publication destination is no longer configured. Its original destination has not been changed.');
  return { target: normalized, descriptor };
}
export async function targetForNewSubmission(q, guideId, { publicationTargets, defaultPublicationTarget } = {}) {
  if (!publicationTargets && !defaultPublicationTarget) return null; // Unconfigured v1 compatibility path.
  if (!defaultPublicationTarget) reject('publication_target_unknown', 'The legacy publication destination is not configured.');
  const fallback = trustedPublicationTarget(defaultPublicationTarget, publicationTargets).target;
  if (fallback.pipeline !== 'legacy-v1') reject('publication_handoff_required', 'Content-repository publication requires an explicit guide handoff.');
  const authority = (await q.query('SELECT target FROM guide_publication_authority WHERE guide_id=$1', [guideId])).rows[0];
  return trustedPublicationTarget(authority?.target || fallback, publicationTargets).target;
}
export async function assertPublicationAuthority(q, row, publicationTargets) {
  if (!publicationTargets && !row.publication_target) return null;
  const { target, descriptor } = trustedPublicationTarget(row.publication_target, publicationTargets);
  const authority = (await q.query('SELECT target FROM guide_publication_authority WHERE guide_id=$1', [row.guide_id])).rows[0];
  if (authority ? !samePublicationTarget(authority.target, target) : target.pipeline !== 'legacy-v1')
    reject('publication_handoff_conflict', 'This guide has changed publication destinations. Reconcile and send a fresh submission; the old snapshot will not be redirected.');
  return { target, descriptor };
}
/** Operator-only, with remote proof obtained before any database lock is held. */
export async function handoffGuidePublication(db, { guideId, target, expectedRevision, expectedHash, contentCommit, verifyContent, reason }) {
  const normalized = validatePublicationTarget(target);
  if (normalized.pipeline !== 'content-pin-v1' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !HASH.test(expectedHash || '') || !SHA.test(contentCommit || '') ||
      typeof reason !== 'string' || !reason.trim() || reason.length > 2000 || typeof verifyContent !== 'function') reject('publication_handoff_invalid', 'An exact content commit, canonical revision, reason and content verification are required.');
  if (await verifyContent({ guideId, target: normalized, contentCommit, contentHash: expectedHash, expectedRevision }) !== true) reject('publication_handoff_unverified', 'The pinned content snapshot does not match this guide.');
  return db.transaction(async q => {
    const current = (await q.query('SELECT g.revision,r.content_hash FROM guides g JOIN guide_revisions r ON r.guide_id=g.id AND r.revision=g.revision WHERE g.id=$1 FOR UPDATE OF g', [guideId])).rows[0];
    if (!current || current.revision !== expectedRevision || current.content_hash !== expectedHash) reject('publication_handoff_conflict', 'The canonical guide changed during the handoff. Verify it again.');
    const prior = (await q.query('SELECT * FROM guide_publication_authority WHERE guide_id=$1 FOR UPDATE', [guideId])).rows[0];
    if (prior?.target?.pipeline === 'content-pin-v1') {
      if (samePublicationTarget(prior.target, normalized) && prior.content_commit === contentCommit) return { changed: false, guideId, target: normalized, version: prior.version };
      reject('publication_handoff_conflict', 'This guide already has a content-repository authority. No destination was changed.');
    }
    const unresolved = (await q.query(`SELECT s.id FROM submissions s LEFT JOIN publication_jobs j ON j.submission_id=s.id
      WHERE s.guide_id=$1 AND COALESCE(s.publication_target->>'pipeline','legacy-v1')='legacy-v1'
      AND s.status NOT IN ('published','rejected') AND NOT EXISTS (
        SELECT 1 FROM submissions replacement JOIN audit_events e ON e.subject_id=s.id::text AND e.action='submission.resubmitted'
        WHERE replacement.id::text=j.provider->>'replacementId' AND replacement.guide_id=s.guide_id AND e.data->>'replacementId'=replacement.id::text
      ) LIMIT 1`, [guideId])).rows[0];
    if (unresolved) reject('publication_handoff_pending', 'Resolve this guide’s legacy submissions and publication jobs before handing it over.');
    const value = (await q.query(`INSERT INTO guide_publication_authority(guide_id,target,canonical_revision,content_hash,content_commit)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(guide_id) DO UPDATE SET target=EXCLUDED.target,canonical_revision=EXCLUDED.canonical_revision,content_hash=EXCLUDED.content_hash,content_commit=EXCLUDED.content_commit,version=guide_publication_authority.version+1,updated_at=now() RETURNING version`, [guideId, JSON.stringify(normalized), expectedRevision, expectedHash, contentCommit])).rows[0];
    await q.query('INSERT INTO audit_events(id,actor_id,action,subject_id,data) VALUES($1,NULL,$2,$3,$4)', [randomUUID(), 'publication.guide_handoff', guideId, JSON.stringify({ target: normalized, revision: expectedRevision, contentHash: expectedHash, contentCommit, reason: reason.trim() })]);
    return { changed: true, guideId, target: normalized, version: value.version };
  });
}
const pinView = row => ({ origin: row.origin, version: row.version, contentCommit: row.content_commit, appCommit: row.app_commit, provider: row.provider });
export function createPinController(db, { leaseMilliseconds = 300000 } = {}) {
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1 || leaseMilliseconds > 300000) throw Error('Invalid pin lease duration');
  return {
    async approvals(guideIds) {
      if (!Array.isArray(guideIds) || !guideIds.length || guideIds.length > 5000 || guideIds.some(id => !/^[a-z0-9][a-z0-9-]{0,100}$/.test(id))) reject('pin_invalid_inventory', 'Invalid content guide inventory.');
      return (await db.query(`SELECT s.*,j.state AS job_state,j.provider AS job_provider,${approvalEventsSql('s')} AS approval_events,
          g.revision AS current_revision,r.content_hash AS current_hash,r.publication_id AS current_publication_id,
          EXISTS(SELECT 1 FROM audit_events e WHERE e.subject_id=s.id::text AND e.action='submission.resubmitted') AS superseded
        FROM submissions s JOIN guides g ON g.id=s.guide_id JOIN guide_revisions r ON r.guide_id=g.id AND r.revision=g.revision
        LEFT JOIN publication_jobs j ON j.submission_id=s.id WHERE s.guide_id=ANY($1::text[]) AND s.status IN ('approved','publishing','published') ORDER BY s.guide_id,s.base_revision,s.created_at,s.id`, [[...new Set(guideIds)]])).rows;
    },
    async withLease(origin, work) {
      if (!ORIGIN.test(origin || '') || typeof work !== 'function') reject('pin_invalid_origin', 'The content pin origin is invalid.');
      const token = randomUUID();
      const claimed = await db.transaction(async q => {
        await q.query('INSERT INTO publication_pin_controllers(origin) VALUES($1) ON CONFLICT DO NOTHING', [origin]);
        return (await q.query(`UPDATE publication_pin_controllers SET lease_token=$2,lease_until=now()+($3 * interval '1 millisecond'),updated_at=now()
          WHERE origin=$1 AND (lease_token IS NULL OR lease_until<now()) RETURNING *`, [origin, token, leaseMilliseconds])).rows[0];
      });
      if (!claimed) reject('pin_busy', 'Another worker is updating this content pin.', { retryable: true });
      const read = async () => {
        const row = (await db.query('SELECT * FROM publication_pin_controllers WHERE origin=$1 AND lease_token=$2 AND lease_until>now()', [origin, token])).rows[0];
        if (!row) reject('lease_superseded', 'A newer worker owns this content pin.');
        return row;
      };
      try {
        return await work({
          read: async () => pinView(await read()),
          async checkpoint({ expectedVersion, contentCommit, appCommit, provider = {}, isDescendant }) {
            if (!Number.isSafeInteger(expectedVersion) || !SHA.test(contentCommit || '') || (appCommit !== undefined && appCommit !== null && !SHA.test(appCommit)) || !provider || typeof provider !== 'object' || Array.isArray(provider)) reject('pin_invalid_checkpoint', 'The content pin checkpoint is invalid.');
            const prior = await read();
            if (prior.version !== expectedVersion) reject('pin_conflict', 'The content pin changed. Read it again.', { retryable: true });
            if (prior.content_commit && prior.content_commit !== contentCommit && (typeof isDescendant !== 'function' || await isDescendant(prior.content_commit, contentCommit) !== true)) reject('pin_not_forward', 'A content pin cannot move backwards or to divergent history.');
            const row = (await db.query(`UPDATE publication_pin_controllers SET content_commit=$4,app_commit=COALESCE($5,app_commit),provider=$6,version=version+1,updated_at=now()
              WHERE origin=$1 AND lease_token=$2 AND lease_until>now() AND version=$3 RETURNING *`, [origin, token, expectedVersion, contentCommit, appCommit || null, JSON.stringify(provider)])).rows[0];
            if (!row) reject('lease_superseded', 'A newer worker owns this content pin.');
            return pinView(row);
          },
        });
      } finally {
        await db.query('UPDATE publication_pin_controllers SET lease_token=NULL,lease_until=NULL,updated_at=now() WHERE origin=$1 AND lease_token=$2', [origin, token]);
      }
    },
  };
}
