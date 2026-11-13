import { createHash } from 'node:crypto';
import { canonical } from './core.mjs';

// Public proof binds the complete immutable approval without exposing receipt
// filenames, account UUIDs, review notes or audit-event references.
export function publicationProofId(receipt) {
  return createHash('sha256').update('pvme-public-approval-v2\0').update(canonical(receipt)).digest('hex');
}
export function matchesPublicationProof(release, guideId, receipt) {
  const proof = release?.guides?.[guideId];
  if (!proof || proof.contentHash !== receipt.contentHash) return false;
  if (release.schemaVersion === undefined) return proof.submissionId === receipt.submissionId;
  return release.schemaVersion === 2 && release.appCommit === release.commit && /^[a-f0-9]{40}$/.test(release.appCommit || '') && /^[a-f0-9]{40}$/.test(release.contentCommit || '') && release.contentOrigin === 'guides-v1' && !Object.hasOwn(proof, 'submissionId') && proof.proofId === publicationProofId(receipt);
}
