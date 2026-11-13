# Staged guide-storage verification

Verified locally on 2026-11-13 against application base
`1eea5744a038aca7933a62927ac9497072cbb39c`.
This is implementation evidence, not permission to activate the migration.

## Automated results

- `npm run build`: passed; 323 complete guide baselines, 352 reader slots,
  existing approved overlay retained.
- `npm run verify`: 202 application/server tests and 192 editor tests passed,
  with zero failures. Night-mode lifecycle and authored text contrast passed.
- Independent adversarial suite: 17 cases passed, including three reproduced
  source-proof failures fixed before staging.
- Joined integration uses real PGlite approvals, durable jobs and pin leases,
  the split publisher, content loader and database gate. GitHub repositories,
  merges and live HTTP manifests are simulated; none is a live staging test.
- An isolated actual build exercises the read-App, pinned Git-object importer
  and public rendering against mocked GitHub. Every output file is scanned for
  private receipt/account identifiers, review text and credentials.
- Existing private receipt files retain their exact bytes. Irrelevant duplicate
  history does not stall publication; unresolved competing active proofs remain
  blocked for explicit reconciliation.

## Audited seed

The dry run contains 323 original baselines, the sealed catalog, one existing
approved overlay, independent-project README and licence references:
328 regular files, 44,321,389 uncompressed bytes. No private review receipts,
application history or executable reader assets are included.

- Manifest SHA-256:
  `2973487d66e2a581904ddc9e061c627c12b5b6cdc18be101b5a7b2a89ffbb0c5`
- Deterministic archive: 3,185,499 bytes; SHA-256:
  `aa313b6f899b4cc8ad4ab7dfb6454d935dba8c8c58a3da0c18c1354a305f8912`

The archive remains local and ignored. Rebuild it with the documented seed
command; no destination revision exists from this work.

## Outstanding acceptance

The connector still returns 404 for the private destination. Exact repository
identity/default branch and selected publisher/read-App installations require
verification. No organization seed, production DDL, grants, handoff, environment
switch or deployment-source change was performed. Real multi-client PostgreSQL
privileges/concurrency, actual cross-repository staging, failure/retry/rollback
and independent architecture-owner review remain required before activation.
See [the rollout runbook](guide-storage-migration.md) and its eight review gates.
