# Disposable PostgreSQL verification

The migration was exercised on a real, rootless PostgreSQL 17.11 process on 2026-11-13. All 13 named checks passed, followed by a separate negative certificate-trust test. This closes the local PostgreSQL compatibility gate. Hosted provider permissions, TLS, pooling and remote publication remain separate gates.

## Reproduce

From the repository root, with dependencies installed, Node.js, OpenSSL and PostgreSQL server binaries available:

```sh
node scripts/verify-local-postgres.mjs --bin /absolute/path/to/postgresql/bin
```

The default binary directory is `.runtime/postgres-real-verification/root/usr/lib/postgresql/17/bin`. The launcher creates its own cluster, database, roles, passwords and certificate authority. It accepts no database URL and never reads `DATABASE_URL`, `MIGRATION_DATABASE_URL`, publisher credentials or application session secrets. The child verifier rejects a non-local connection configuration and checks the unique cluster name. This is an explicit verification command; the regular test suite does not start PostgreSQL.

The observed run used Debian's signed `trixie` package index and the free packages `postgresql-17` and `postgresql-client-17`, version `17.11-0+deb13u1`. Packages were downloaded and extracted with `dpkg-deb -x` beneath the ignored `.runtime` directory. Nothing was installed system-wide, and no system service or cloud database was created. Existing system libraries satisfied the binaries' dependencies. Another environment may need its own compatible PostgreSQL installation or extracted dependencies.

## Recorded evidence

The latest verified run finished at `2026-11-13T18:35:34.300Z`:

- PostgreSQL: `17.11 (Debian 17.11-0+deb13u1)`; negotiated TLS: `TLSv1.3`.
- Reviewed source tree: `6128f762e78953eba9186a75680ec3012b10b03e`.
- Sanitized report: `.runtime/postgres-selected-role-eNCr8n/report.json`.
- Separate runtime clients used distinct PostgreSQL backend IDs, `75` and `67`.
- The report includes SHA-256 fingerprints of the database client, migrations, routing, service, job, webhook, approval and publication-gate modules actually read by the verifier. The tree hash identifies the checked-out base; the report fingerprints bind the tested production files even when a worktree has local changes.

The report contains no connection strings, passwords, keys or guide source. It is a local ignored artifact and is not shipped with the application.

## Checks performed

1. The unchanged production `createDatabase` client connected with certificate verification enabled. A separate process without the generated CA rejected the same server certificate. A URL parameter requesting disabled SSL did not relax the production client's verification settings.
2. A dedicated non-superuser operator installed v1 and seeded synthetic guide fixtures. A separate runtime role received only the documented baseline grants and migration-specific grant delta.
3. The real `002_publication_targets.sql` migration and its idempotent rerun preserved the original approved snapshot, publication receipt and history digests.
4. The actual `verifyPublicationGate` aggregate approval/inventory query ran under runtime grants inside `SET TRANSACTION READ ONLY`. One legacy approved overlay and both expected baselines passed; an altered private review receipt failed. History, jobs, guide authority and controller digests stayed unchanged.
5. Runtime role ownership, superuser privileges, role membership and schema DDL were absent. Settings, authority and guide-target writes were denied. All five relevant trigger functions were security invokers.
6. Concurrent saves from independent runtime pools produced one successful compare-and-swap and one revision conflict, preserving the successful draft.
7. An old-version submission INSERT was bound to the immutable legacy destination by the database trigger. A drained synthetic guide was then handed off by the operator, and a new submission retained its content destination. Attempts to rewrite submitted source, target, audit history or guide history failed.
8. Runtime controller writes updated guide pin mirrors under the documented grants. Stale versions, non-forward proof and forged direct mirror updates failed.
9. Competing controller clients refused a live lease. After deliberate local lease expiry, the superseded worker could neither checkpoint nor release its replacement's lease.
10. After the durable controller advanced to its current content commit, the real read-only build query verified both a legacy and a content approval, exact baseline inventory and the active content pin. An older pin with identical guide hashes failed with `content_pin_not_current`. Missing or false source proof failed closed. The explicit mock source callback checked the exact app commit, content pin and both approval rows. Each successful gate used one aggregate authority query, with no history or job mutations.
11. Competing publication workers refused duplicate claims, and an expired worker could not overwrite its replacement's result.
12. The real HTTP webhook handler rolled back both delivery deduplication and scoped job wake after an injected failure following SQL execution. Redelivery then succeeded. A content-repository event did not wake the legacy job.
13. The original approved snapshot and receipt remained unchanged after the concurrent operations.

The handoff ancestry/content callback, build-gate source proof and publication-provider responses are explicit synthetic fixtures. This verifies database boundaries and workflow behavior, not a live GitHub or Vercel deployment.

## Isolation and cleanup

Subprocess environments use an OS/tool allowlist (`PATH`, `LANG`) plus only the generated `NODE_EXTRA_CA_CERTS` where needed. They do not inherit production database, GitHub, Discord, session or `NODE_OPTIONS` values. PostgreSQL accepts only loopback TCP, requires SCRAM and TLS, and has no Unix socket. The launcher disables trust in unencrypted loopback connections.

On exit, the launcher stops its cluster and deletes the plaintext connection configuration, bootstrap password, CA private key and server private key it created. It retains the stopped database files, public certificates, server log and sanitized report under `.runtime` for inspection. Those remaining files are local test artifacts; remove that specific run directory when no longer needed.

No production migration, role grant, per-guide handoff, credential change, repository transfer or production cutover was performed. Before cutover, an independently authorized isolated hosted staging connection must still verify actual provider grants, TLS trust, pool behavior and the intended remote lineage/integration. This local evidence does not authorize that cutover.
