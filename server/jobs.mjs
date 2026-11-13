import { validatePublicationTarget, samePublicationTarget, assertPublicationAuthority } from './publication-targets.mjs';
import { approvalEventsSql, hasValidApproval } from './approval.mjs';
import { randomUUID } from 'node:crypto';
import { validateDocument } from '../editor/shared/model.mjs';
import { documentHash, fail } from './core.mjs';
import { audit, requireUser, needsFreshReview } from './service.mjs';
import { PublicationError, withProviderBudget } from './github.mjs';
export function createJobRunner(db, provider, { origin, publicationTargets } = {}) {
  async function selectProvider(row) {
    if (!row.publication_target) {
      if (typeof provider.resolve === 'function') throw new PublicationError('publication_target_unknown', 'This publication has no immutable destination. A maintainer must reconcile it.');
      return provider;
    }
    const target = validatePublicationTarget(row.publication_target);
    await assertPublicationAuthority(db, row, publicationTargets);
    if (typeof provider.resolve !== 'function') throw new PublicationError('publication_target_unknown', 'The original publication destination is not configured.');
    const selected = await provider.resolve(target, row);
    if (!selected || !samePublicationTarget(selected.target, target) || typeof selected.provider?.ensurePullRequest !== 'function' || typeof selected.provider?.reconcile !== 'function')
      throw new PublicationError('publication_target_unknown', 'The publication provider does not match its immutable destination.');
    return selected.provider;
  }
  function validateResult(row, result) {
    if (!result || !['awaiting_merge','awaiting_deployment','published'].includes(result.state) || !result.provider) throw new PublicationError('invalid_provider_response', 'The publication state could not be verified.');
    if (row.publication_target?.pipeline !== 'content-pin-v1') return;
    const info = result.provider, sha = value => /^[a-f0-9]{40}$/.test(value || '');
    if (info.pipeline !== 'content-pin-v1' || !['content_review','website_update','deployment','live'].includes(info.phase) ||
        (info.merged && (!sha(info.appMergeSha) || !sha(info.contentMergeSha) || !['deployment','live'].includes(info.phase))) ||
        (result.state === 'published' && (!info.merged || info.phase !== 'live' || !sha(info.appCommit) || !sha(info.contentCommit) || info.deployedCommit !== info.appCommit)))
      throw new PublicationError('invalid_provider_response', 'The website pin or live publication could not be verified.');
  }
  async function claim(submissionId = null) {
    return db.transaction(async q => {
      // FIFO per guide, durable cross-process leases, and optimistic lease fencing.
      const row = (await q.query(`SELECT j.*,s.guide_id FROM publication_jobs j JOIN submissions s ON s.id=j.submission_id
        WHERE ($1::uuid IS NULL OR j.submission_id=$1) AND ((j.state IN ('queued','retry','awaiting_merge','awaiting_deployment') AND j.available_at<=now()) OR (j.state='working' AND j.lease_until<now()))
        AND NOT EXISTS (SELECT 1 FROM publication_jobs earlier JOIN submissions es ON es.id=earlier.submission_id
          WHERE es.guide_id=s.guide_id AND earlier.state NOT IN ('published','blocked')
          AND (earlier.created_at,earlier.submission_id)<(j.created_at,j.submission_id))
        ORDER BY j.available_at,j.created_at,j.submission_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [submissionId])).rows[0];
      if (!row) return null;
      const lease = randomUUID();
      await q.query("UPDATE publication_jobs SET state='working',lease_token=$2,lease_until=now()+interval '5 minutes',attempts=attempts+1,updated_at=now() WHERE submission_id=$1", [row.submission_id, lease]);
      await q.query("UPDATE submissions SET status='publishing',version=version+1 WHERE id=$1 AND status='approved'", [row.submission_id]);
      return { ...row, lease_token: lease, attempts: row.attempts + 1 };
    });
  }
  async function complete(job, result) {
    return db.transaction(async q => {
      const row = (await q.query('SELECT * FROM submissions WHERE id=$1', [job.submission_id])).rows[0];
      const current = (await q.query('SELECT g.*,r.content_hash FROM guides g JOIN guide_revisions r ON r.guide_id=g.id AND r.revision=g.revision WHERE g.id=$1 FOR UPDATE OF g', [row.guide_id])).rows[0];
      const lease = (await q.query("SELECT * FROM publication_jobs WHERE submission_id=$1 AND lease_token=$2 AND state='working' FOR UPDATE", [job.submission_id, job.lease_token])).rows[0];
      if (!lease) return { state: 'superseded' };
      validateResult(row, result);
      // Merged exact snapshots become the editing baseline; live status waits for deployment.
      if (result.provider.merged && ['awaiting_deployment', 'published'].includes(result.state)) {
        const previous = (await q.query('SELECT * FROM guide_revisions WHERE publication_id=$1', [row.id])).rows[0];
        if (!previous) {
          if (current.revision !== row.base_revision || current.content_hash !== row.baseline_hash) throw new PublicationError('source_conflict', 'A newer canonical guide exists; publication requires reconciliation.');
          const next = current.revision + 1;
          await q.query('INSERT INTO guide_revisions(guide_id,revision,document,content_hash,publication_id) VALUES($1,$2,$3,$4,$5)', [row.guide_id, next, JSON.stringify(row.document), row.content_hash, row.id]);
          await q.query('UPDATE guides SET revision=$2 WHERE id=$1', [row.guide_id, next]);
          await audit(q, null, 'publication.merged', row.id, { contentHash: row.content_hash, mergeCommit: result.provider.appMergeSha || result.provider.mergeSha, revision: next, ...(row.publication_target?.pipeline === 'content-pin-v1' ? { contentCommit: result.provider.contentMergeSha, origin: row.publication_target.origin } : {}) });
        }
      }
      await q.query("UPDATE publication_jobs SET state=$3,provider=$4,attempts=0,lease_token=NULL,lease_until=NULL,last_error=NULL,available_at=now()+interval '2 minutes',updated_at=now() WHERE submission_id=$1 AND lease_token=$2", [row.id, job.lease_token, result.state, JSON.stringify(result.provider)]);
      if (result.state === 'published') {
        await q.query("UPDATE submissions SET status='published',version=version+1 WHERE id=$1", [row.id]);
        await audit(q, null, 'publication.deployed', row.id, { contentHash: row.content_hash, commit: result.provider.deployedCommit, ...(row.publication_target?.pipeline === 'content-pin-v1' ? { contentCommit: result.provider.contentCommit, origin: row.publication_target.origin } : {}) });
      }
      return { state: result.state };
    });
  }
  async function checkpointProvider(job, info) {
    if (!Number.isSafeInteger(info?.number) || info.number < 1 || !/^[a-f0-9]{40}$/.test(info.branchSha || '')) throw new PublicationError('invalid_provider_response', 'The publication reference could not be verified.');
    const updated = await db.query("UPDATE publication_jobs SET provider=$3,updated_at=now() WHERE submission_id=$1 AND lease_token=$2 AND state='working' RETURNING submission_id", [job.submission_id, job.lease_token, JSON.stringify(info)]);
    if (!updated.rows.length) throw new PublicationError('lease_superseded', 'A different worker now owns this publication.');
  }
  async function recordFailure(job, error) {
    const typed = error instanceof PublicationError || error?.name === 'PublicationTargetError';
    const code = typed ? error.code : 'publication_unavailable';
    const retryable = !typed || error.retryable;
    const state = retryable && job.attempts < 12 ? 'retry' : 'blocked';
    const delay = Math.min(900, Math.pow(2, Math.min(job.attempts, 9)) * 5);
    await db.transaction(async q => {
      const updated = await q.query("UPDATE publication_jobs SET state=$3,last_error=$4,lease_token=NULL,lease_until=NULL,available_at=now()+($5 * interval '1 second'),updated_at=now() WHERE submission_id=$1 AND lease_token=$2 AND state='working' RETURNING submission_id", [job.submission_id, job.lease_token, state, code, delay]);
      if (updated.rows.length) await audit(q, null, `publication.${state}`, job.submission_id, { code, attempt: job.attempts });
    });
    return { state, code };
  }
  return {
    async runOne({ submissionId = null } = {}) {
      if (!provider) fail(503, 'publication_unavailable', 'Publication is not configured.');
      const job = await claim(submissionId);
      if (!job) return { state: 'idle' };
      let snapshot = null, selectedProvider = null;
      try {
        return await withProviderBudget(async () => {
          const row = (await db.query(`SELECT s.*, ${approvalEventsSql('s')} AS approval_events FROM submissions s WHERE s.id=$1`, [job.submission_id])).rows[0];
          snapshot = row;
          const validSnapshot = row && ['approved', 'publishing'].includes(row.status) && hasValidApproval(row) && documentHash(row.document) === row.content_hash && documentHash(row.baseline_document) === row.baseline_hash && validateDocument(row.document, { baseline: row.baseline_document }).valid;
          if (!validSnapshot) throw new PublicationError('snapshot_corrupt', 'The approval failed integrity verification.');
          selectedProvider = await selectProvider(row);
          const info = job.provider?.number ? job.provider : await selectedProvider.ensurePullRequest(row);
          await checkpointProvider(job, info);
          const result = await selectedProvider.reconcile(row, info, origin);
          return await complete(job, result);
        });
      } catch (error) {
        if (error.code === 'lease_superseded') return { state: 'superseded' };
        if (error.publication) await checkpointProvider(job, error.publication).catch(() => {});
        if (snapshot && needsFreshReview(error.code) && !job.provider?.number && selectedProvider?.findReviewNumber) {
          // Keep a private diagnostic link after a changed-branch failure, but
          // never turn an unverified head SHA into trusted publication metadata.
          const number = await selectedProvider.findReviewNumber(snapshot).catch(() => null);
          if (Number.isSafeInteger(number) && number > 0) await db.query("UPDATE publication_jobs SET provider=provider || $3::jsonb WHERE submission_id=$1 AND lease_token=$2 AND state='working'", [job.submission_id, job.lease_token, JSON.stringify({ diagnosticPrNumber: number })]);
        }
        return recordFailure(job, error);
      }
    },
    async retry(actor, id) {
      return db.transaction(async q => {
        await requireUser(q, actor, { admin: true, lock: true });
        const row = (await q.query('SELECT * FROM publication_jobs WHERE submission_id=$1 FOR UPDATE', [id])).rows[0];
        if (!row) fail(404, 'publication_not_found', 'Publication not found.');
        if (row.state === 'working' && new Date(row.lease_until) > new Date()) fail(409, 'publication_running', 'Publication is already being checked.');
        if (row.state === 'published') return { state: 'published' };
        if (row.provider?.replacementId) fail(409, 'publication_superseded', 'This publication has a fresh replacement submission.');
        const snapshot = (await q.query('SELECT * FROM submissions WHERE id=$1', [id])).rows[0];
        try { await assertPublicationAuthority(q, snapshot, publicationTargets); } catch (error) { fail(error.code === 'publication_handoff_conflict' ? 409 : 503, error.code === 'publication_handoff_conflict' ? 'fresh_review_required' : error.code, error.message); }
        if (needsFreshReview(row.last_error)) fail(409, 'fresh_review_required', 'Save a reconciled draft and submit it for fresh review. The original approval cannot be reused for changed content.');
        await q.query("UPDATE publication_jobs SET state='queued',attempts=0,available_at=now(),lease_token=NULL,lease_until=NULL,updated_at=now() WHERE submission_id=$1", [id]);
        await audit(q, actor, 'publication.retry_requested', id);
        return { state: 'queued' };
      });
    },
    async check(actor, id) {
      await requireUser(db, actor, { review: true });
      const row = (await db.query('SELECT state FROM publication_jobs WHERE submission_id=$1', [id])).rows[0];
      if (!row) fail(404, 'publication_not_found', 'There is no approved publication to check.');
      if (row.state === 'blocked') fail(409, 'publication_blocked', 'A maintainer must resolve the publication issue before retrying.');
      await db.query("UPDATE publication_jobs SET available_at=now() WHERE submission_id=$1 AND state IN ('queued','retry','awaiting_merge','awaiting_deployment')", [id]);
    },
    async wake(q = db, { targets, includeLegacyUnbound = false } = {}) {
      if (targets === undefined) return q.query("UPDATE publication_jobs SET available_at=now() WHERE state IN ('awaiting_merge','awaiting_deployment','retry')");
      if (!Array.isArray(targets)) throw Error('Publication wake destinations must be an array.');
      const selected = targets.map(validatePublicationTarget);
      if (includeLegacyUnbound && !selected.some(target => target.pipeline === 'legacy-v1')) throw Error('Unbound legacy jobs require a verified legacy destination.');
      return q.query(`UPDATE publication_jobs j SET available_at=now() FROM submissions s WHERE s.id=j.submission_id AND j.state IN ('awaiting_merge','awaiting_deployment','retry')
        AND (EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) destination WHERE destination=s.publication_target) OR ($2 AND s.publication_target IS NULL))`, [JSON.stringify(selected), includeLegacyUnbound]);
    },
    async prune() {
      await db.query('DELETE FROM oauth_states WHERE expires_at<now()');
      await db.query('DELETE FROM sessions WHERE expires_at<now()');
      await db.query('DELETE FROM rate_limits WHERE expires_at<now()');
      await db.query("DELETE FROM webhook_deliveries WHERE received_at<now()-interval '30 days'");
    },
  };
}
