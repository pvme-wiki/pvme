# Hosted editor independent audit

Date: 2026-11-11 UTC

## Result

The expanded integrated checkout passed all **34 independent regression checks**:

`node --test scripts/independent-*.test.mjs server/tests/independent-*.test.mjs`

This is a code and local-integration result, not evidence that external services are connected or that production is ready. No external writes, credentials, resources or deployments were created during this audit.

## Reproduced findings, now fixed

1. **PostgreSQL TLS could be disabled through URL aliases.** `?ssl=0` and `?ssl=no-verify` overrode explicit TLS settings in node-postgres. The configuration now rejects unsafe values, and the database adapter extracts only connection identity fields before applying verified TLS.
2. **OAuth returned to the wrong page.** Success and failure redirected to `/editor/` while the hosted UI is under `/edit/`. Both fixed return paths are covered by tests.
3. **Rate limiting broke authenticated API calls.** SQL referenced `$1` and `$3` but supplied an unused, untyped `$2`. PostgreSQL rejected the statement and the handler returned 503. The two-parameter binding is now tested through actual authenticated requests.
4. **Account switching retained another account's private UI state.** Reconnection from A to B kept A's document/reviews and could write A's draft into B's recovery key. Identity changes now quarantine recovery under A before clearing state, dialogs and caches. Identity generations reject late responses and old-owner mutations. Logout, session expiry and role loss are covered.
5. **Approved dollar syntax corrupted rendered reader titles/headings.** String replacement interpreted contributor text such as `$1`, `$&`, `$\`` and `$'` as substitution directives. Callback replacements preserve literal text. An isolated full build verifies H1, page title, TOC and release manifest against the approved document.
6. **A stale merged PR could roll the public build back despite backend publication guards.** The loader selected a receipt matching the current file without checking newer receipt history. It now verifies a contiguous, non-forking hash lineage and requires the terminal content. A read-only production gate also checks exact database approval, supersession and current canonical state. An additional reproduced inventory gap, where omitted overlays restored original source, is fixed: every production build checks the full seeded catalog and merged-guide inventory, including builds with zero overlays. Missing or unavailable authority stops production builds.

## Coverage

- Real PostgreSQL-compatible PGlite schema, transactions, constraints and immutable-history triggers.
- Owner-scoped drafts/submissions, rejected forged identity/role fields, reviewer access, role-change session invalidation, and logout revocation.
- Same-origin mutation requirements, session-bound CSRF, secure host-only authentication cookies, one-use browser-bound OAuth state, identity-only Discord scope and ephemeral token revocation.
- Missing/malformed configuration, invitation-only admission and invitation revocation, expired/disabled sessions, safe operational error messages and bounded request bodies.
- Webhook HMAC signatures, private-repository and installation binding, duplicate-delivery handling and protected job authorization.
- Optimistic draft conflicts, fixed submission snapshots, rejected history mutation, stale canonical-publication rejection and expired-lease fencing.
- Actual hosted adapter combined with a DOM/network VM fixture for account-switch and late-response privacy regressions. This is not a browser-rendering or screenshot test.
- Full isolated reader build with approved fixture content; public text scanned for contributor/reviewer identifiers and private review summary/note markers. Private server, API, environment, runtime and receipt directories are absent from output.
- All 323 imported baselines validate. Independent adversarial mutations cover 212 guides with newly editable rich blocks: text remains escaped, while original source, node structure, attributes and edit permissions remain protected.
- Exact 1,750,000-byte UTF-8 documents, oversized rejection without a saved-version change, bounded snapshot-plus-baseline responses and owner-scoped metadata-only draft lists.
- Blocked-publication replacements preserve original snapshots/approvals, reject foreign owners and CSRF, require fresh review, return one replacement after a lost acknowledgement and stop old jobs. Private PR links are derived from the configured repository and remain reviewer-only after role changes.
- Six receipt-lineage regressions cover stale overlays, same-baseline forks, reversed timestamps, valid multi-step history, missing revisions, wrong baseline hashes and identical duplicate approvals.
- Production authority regressions use real PGlite data and cover exact receipt facts, supersession before replacement reaches Git, omitted overlays, stale canonical revisions, changed/missing/unseeded originals, unavailable database and sanitized operational errors. Offline build fixtures explicitly use preview mode without database credentials.
- The separate GitHub REST-contract suite was also independently run and passed 4/4 on the recovered backend. It uses a local fake, including lost acknowledgements, deterministic refs/PRs, changed baselines, branch tampering and merged-branch deletion recovery.

## Deployment checks still required

- Provision and verify the real PostgreSQL service, migrations, restricted runtime identity and backups. Private Git stores approved snapshots and receipts; it is not a replacement for database backups containing accounts, drafts, history and review state.
- Seed and verify all 323 baseline documents before a production build. Production intentionally cannot use the offline preview path or bypass authority for an empty overlay set.
- Verify actual Discord application redirect settings and invited-user sign-in, logout, cancellation, denial and expiry in browsers.
- Verify the GitHub App installation, private repository, branch protection, required checks and maintainer merge workflow. Contributors do not need a GitHub account; approval does not automatically merge.
- Verify Vercel API rewrites, custom-domain request origin, response cookies/headers, webhook delivery, scheduled runner authentication and actual job execution. The `{ fetch(request) }` export is supported by current Vercel Functions documentation, but its deployment was not smoke-tested in this audit.
- Confirm publication status only after the exact approved snapshot and receipt are merged and the configured reader serves its matching release hash from that commit or a verified descendant.
- Keep deployment and branch controls in place. The authority gate checks at build time and again after tests; it does not close old PRs, revoke already-built artifacts, prevent manual deployment promotion, or provide a lock covering the interval until the host goes live. Do not claim those external actions are prevented by the application.
- PGlite tests exercise real SQL but do not replace tests against the selected hosted PostgreSQL pool with distinct serverless workers and real network failures.

Relevant runtime documentation: https://vercel.com/docs/functions/quickstart
