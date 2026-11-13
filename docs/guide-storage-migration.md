# Guide storage migration: staged operator runbook

**Status: staged implementation; organization access and the remote publication
path are unverified. No production switch is authorized by this runbook.**

The canonical architecture and decision record lives outside application code:
[PvME private guide storage migration draft](https://chatgpt.com/space/page_967f8f7774d881918438f3b28fb41182).
The separate [eight-gate migration preflight](https://chatgpt.com/space/page_dcf4c1a12b388191a07fceabf1243744)
is a required source for staged review. It explicitly withholds migration
approval until the actual patch, schema, permissions, rollout plan and evidence
are reviewed. Prior webhook approval and local test results do not satisfy
that review.

This file documents implementation interfaces and acceptance operations. Keep
architecture decisions in those records; do not turn the app repository into
the project Wiki.

## Reconciled starting point

Editor PR 6 was merged and verified at e344a41. The separate atomic webhook
delivery/wake repair in PR 7 was merged and verified in production at
1eea5744a038aca7933a62927ac9497072cbb39c before migration work began.
[Editor PR 6](https://github.com/zarnab222-dev/pvme/pull/6) ·
[Webhook PR 7](https://github.com/zarnab222-dev/pvme/pull/7).

At the migration checkpoint, the connected GitHub integration returned 404 for
the intended private destination, pvme-wiki/guides; its accessible installation
inventory showed only the personal account. The destination's numeric identity,
actual base branch and scoped organization installation are not established.
A private-resource 404 can mean missing authentication or access; it does not
prove absence. Do not guess an installation or repository ID.
[GitHub private-resource errors](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource).

The existing private personal app repository, zarnab222-dev/pvme, its Vercel
project, domains, Hobby plan and owner control stay in place. Until staged
acceptance and an explicit operator activation, the existing publication
pipeline remains authoritative.

## Platform and identity boundaries

Vercel Hobby cannot directly deploy from a private GitHub organization
repository. Keep the Git deployment source personal and consume the
organization repository as private guide data. The two-repository bridge here
is this application's design, not a native Vercel split-repository feature or
a claim that a CLI/hook bypasses plan rules.
[Vercel Git documentation](https://vercel.com/docs/git).

Keep a genuine owner merge of the personal app update. Vercel documents Hobby
owner/commit eligibility and a personal-account collaboration exception; do
not assume that every automation identity can deploy. Verify actual owner
merge eligibility during acceptance. Never forge the owner's commit identity
or alter organization membership to make a deployment pass.

GitHub Free organization wikis are available for public repositories; private
wikis require a qualifying paid plan. Preserve the private Pages/Space fallback
linked above. Do not make the guide repository public, enable public Pages or
upgrade a plan to obtain a wiki.
[GitHub wiki availability](https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis).

The site and storage project are independent and unofficial. Preserve PvME
contributors' attribution, source URLs, source hashes and existing licence
references. Existing game/media rights remain separate from guide-text rights.
A new import commit identifies its actual creator or publication bot; it must
not manufacture upstream authorship, affiliation, anonymity or Git history.

## Store ownership

| Store | Material retained |
| --- | --- |
| Personal app repository | Executable application, reader snapshot/slot manifests and immutable import references; full private approval receipt lineage; the app-owned content pin |
| Private guides repository | Audited normalized original baselines, sealed catalog metadata, current approved guide snapshots, manifest hashes, independent scope and licence references |
| Private approval database | Accounts, immutable submissions and approval/audit authority; frozen repository routing; per-guide handoff state; publication and pin-controller leases |
| Public website | Approved rendering, attribution and minimal publication fingerprints; no private review notes, account identities, installation bindings, credentials or private review URLs |
| Private project Space | Canonical architecture, decisions, operating context and migration evidence, outside app code |

The initial seed is data-only. It must not contain content/reviews, review
summaries/notes, contributor or reviewer account identifiers, audit-event
references, credentials, private PR discussions, application files or .git.
Do not copy the old repository's commits, branches, tags or full history into
the organization repository. Baseline source provenance is retained in the
documents; a source attribution is not a forged Git author.

The private app receipts remain complete. A fresh data repository must not
cause revision reset, receipt fabrication or loss of earlier approval
lineage. The database and the retained app receipts remain publication
authority; the organization manifest alone is not an approval.

## Staged interfaces

The following names describe the staging implementation and must be checked
against its tests before operator use.

| Interface | Contract |
| --- | --- |
| scripts/prepare-guide-seed.mjs | Validates the known baseline/catalog and current approved overlays; dry run by default; optional local output under a fresh ignored .runtime directory |
| server/content-store.mjs | Shared strict repository, pin, manifest, payload and document validation; origin guides-v1; manifest.json in the content repository |
| scripts/load-build-content.mjs | Loads an app-owned content/guide-store.json pin and fetches its exact immutable source before normal build validation |
| scripts/fetch-guide-store.mjs | Read-only exact-commit payload fetch with audit output; the inspection CLI uses the same renewable selected-repository read-App provider as builds |
| server/guide-store-read-auth.mjs | createGuideReadTokenProvider validates two selected-repository read-App bindings and mints isolated expiring read tokens for trusted builds |
| server/guide-store-operator.mjs | Protected prepareGuideHandoff returns a read-only plan and explicit apply function; CLI defaults to dry run, with --apply required for authority mutation |
| server/publication-targets.mjs | Frozen legacy-v1/content-pin-v1 targets, handoffGuidePublication and a fenced createPinController; operator APIs, not a migration command |
| server/publication-proof.mjs | Domain-separated publicationProofId binds an exact private receipt to schema-2 public proof without exposing its fields |
| server/guide-store-config.mjs | Complete legacy-app and guide-store runtime bindings; stage shadow or active; absent staging configuration preserves the legacy path |
| content-pin-v1 publication target | Staged content-merge → app-pin/receipt update → owner merge → verified production publication route; distinct from legacy reconciliation |

The content-pin-v1 name describes the publication protocol. The data pin's
version-1 origin identifier is guides-v1; these are not repository IDs.

The app-owned content/guide-store.json pin has exactly these fields:

- schemaVersion: version 1
- mode: shadow or active
- origin: guides-v1
- repository: verified numeric id, owner, repo and actual base branch
- contentCommit: the full immutable Git commit SHA
- manifestSha256: SHA-256 of the exact manifest bytes at that commit
- guideIds: sorted, unique IDs whose authority is covered by the pin

No branch-tip lookup or mutable latest-content environment value selects the
build's guide version. Credentials authorize reading the pin; they do not pick
a different source. Repository identity in the pin must match the protected
configured binding.

The content manifest seals the complete original baseline inventory and
catalog, plus current guide overlays and their hashes/revisions. Only the
manifest, declared baseline/guide JSON paths and sealed documentation/licence
references are fetched. Validate count/size budgets, regular-file modes,
UTF-8, JSON, source identities, unchanged original baselines and all digests.
Reject symlinks, traversal, unexpected paths, executable input and catalog
drift. Never execute content-repository scripts, workflows, package manifests
or build configuration.

A shadow pin validates the candidate without making it authoritative. An
active pin must not fall back to mutable main, stale cache or embedded legacy
content when a handed-off guide cannot be fetched or validated. A failure
stops the build and retains the working production release.

### Local seed inspection

These commands prepare no remote repository and grant no access:

    node scripts/prepare-guide-seed.mjs

To materialize a local audited payload, choose a new directory under this
worktree's ignored .runtime directory:

    node scripts/prepare-guide-seed.mjs --output .runtime/guide-seed-review

The output is a data-only payload, deterministic archive and file/hash audit.
Do not reuse an existing output directory or treat a successful dry run as
proof of destination identity, remote access, publication or migration
activation. Inspect the audit and perform the privacy scan before any
separately authorized destination write.

After identity, remote commit, pin and read access are established, the
standalone fetch inspection is:

    node scripts/fetch-guide-store.mjs --pin content/guide-store.json

An optional --output pointing to a new ignored .runtime subdirectory writes
payload/, pin.json and fetch-audit.json. This CLI uses the same
createGuideReadTokenProvider and renewable selected-repository read-App
bindings as the trusted build. It does not use a static GUIDE_STORE_READ_TOKEN
or install an App; the verified credentials described below are required.
Do not run it against an invented repository binding or treat local synthetic
fixtures as remote evidence.

## Credential and access requirements

Connector access for migration tooling and credentials used by the running
application are separate requirements. A successful tool connection does not
prove that the runtime publisher or a Vercel build can read the destination.

| Purpose | Required scope |
| --- | --- |
| Migration tooling | Read/write access only to the selected private guides repository after its identity is verified; no unrelated organization repositories |
| Legacy app publisher | Existing selected personal app repository/installation and minimum Contents/Pull requests write permissions |
| Guide publisher | Selected guides repository through its distinct verified organization installation; minimum Contents/Pull requests write permissions |
| Trusted build fetch/proof verification | Two selected-repository read-App installations, one for guides and one for the personal app; Contents and Pull requests read only, plus Metadata read; no publication-write App key in build inputs |

GitHub App installation tokens are scoped to a particular installation and
can be restricted further by repository and permissions. They cannot reach
repositories the installation was not granted. Installation tokens expire;
the documented lifetime is one hour. Cache them by installation, repository
and permissions, and renew through the intended trusted credential path.
[Installation-token scope and expiry](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

The staged trusted build uses createGuideReadTokenProvider, with a separate
read-App binding for each of the guides repository and personal app
repository. It verifies App/installation/account identity, selected-repository
mode, a private repository with the exact configured numeric identity, and
maximum permissions of Contents read, Pull requests read and Metadata read.
It mints a token restricted to the one selected repository, isolates caches by
repository and renews an expiring token on the next request. It does not depend
on a static production GUIDE_STORE_READ_TOKEN.

The content read binding uses GUIDE_STORE_READ_APP_ID,
GUIDE_STORE_READ_INSTALLATION_ID and GUIDE_STORE_READ_PRIVATE_KEY. The app
read binding uses GUIDE_STORE_APP_READ_APP_ID,
GUIDE_STORE_APP_READ_INSTALLATION_ID and GUIDE_STORE_APP_READ_PRIVATE_KEY.
Both also require their exact GUIDE_STORE_* or GITHUB_* repository identity.
These are read-only App credentials, separate from publication-write keys;
requesting a reduced token from a write-capable App is not the same boundary.

No actual read-App installation, credential or remote renewal behavior is
established by this implementation. The owner must separately arrange the
selected-repository read installations. Verify fresh tokens, denied/wrong
installations, expiry/retry and source fetch performance in a trusted staged
build before activation. Keep all keys/tokens server-side, environment-scoped
and out of untrusted previews, pins, Git files, logs and public output.

The runtime guide-store configuration currently names GUIDE_STORE_STAGE,
GUIDE_STORE_REPOSITORY_ID, GUIDE_STORE_OWNER, GUIDE_STORE_REPO,
GUIDE_STORE_BASE_BRANCH, GUIDE_STORE_APP_ID, GUIDE_STORE_INSTALLATION_ID,
GUIDE_STORE_APP_PRIVATE_KEY and GUIDE_STORE_WEBHOOK_SECRET, alongside the
existing complete legacy configuration and verified GITHUB_REPOSITORY_ID.
These names are not permission grants. Do not populate identity fields from
guesses or enable partial staging configuration.

## Database migration and grant review

The additive 002_publication_targets.sql migration is operator-only.
migrate(db, { legacyTarget }) applies pending migrations transactionally under
an advisory lock. The existing operator CLI action remains:

    node server/manage.mjs migrate

First application of migration 002 requires MIGRATION_LEGACY_TARGET_JSON
containing the independently verified original legacy-v1 target tuple, even
for a fresh database. This is protected operator input, not a target inferred
from the new configuration. Omission fails closed. An already migrated
database may rerun without the tuple; a supplied tuple must match its immutable
original binding. The command is documented here, not executed; no production
DDL or grant change has been performed by this staging work. Do not run seed
as a migration or recovery substitute.

Review the actual 002 schema and invoker-trigger definitions together with the
existing least-privilege setup. Keep object ownership, DDL and handoff
authority in a protected operator identity, separate from the application
runtime. The required privilege delta is:

| Object | Runtime access | Protected operator access |
| --- | --- | --- |
| publication_migration_settings | SELECT only; no INSERT, UPDATE or DELETE | Initial verified legacy binding through migration; immutable afterward |
| guide_publication_authority | SELECT only; no INSERT, UPDATE or DELETE | Explicit handoff writes with remote proof, drain and revision/hash recheck |
| publication_pin_controllers | SELECT, INSERT and UPDATE for bridge controller rows, leases and checkpoints; no DELETE | Inspect/reconcile under approved fenced maintenance |
| guides.publication_target | SELECT through existing guide reads; no runtime UPDATE | Updated by the authority-sync invoker trigger during explicit handoff |
| guides.publication_pin | SELECT and column UPDATE for the pin-controller mirror invoker trigger | Inspect/reconcile without bypassing pin/approval fences |
| submissions.publication_target | Included in existing submissions INSERT; no UPDATE | Original historical backfill through migration; immutable afterward |

Existing runtime UPDATE(revision) on guides remains necessary. Adding the
publication_target column does not require expanding runtime submission
UPDATE privileges: the existing table INSERT covers its initial value and
the immutable-target trigger rejects later changes. Runtime controller
privileges deliberately do not confer authority-table writes.

The following SQL is a **review-only example**, never an executed migration
or universal grant script. It assumes the already selected public schema and
pre-existing pvme_runtime role from server/SETUP.md. An operator must verify
the actual names, installed schema and inherited/PUBLIC privileges first.
Preserve the existing approved grants on unrelated objects.

```sql
-- Example only: review against the installed 002 schema and selected role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.publication_migration_settings,
     public.guide_publication_authority FROM pvme_runtime;
GRANT SELECT ON public.publication_migration_settings,
  public.guide_publication_authority,
  public.publication_pin_controllers TO pvme_runtime;

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.publication_pin_controllers FROM pvme_runtime;
GRANT INSERT, UPDATE ON public.publication_pin_controllers TO pvme_runtime;

-- Remove any direct broad guide UPDATE before granting only intended columns.
REVOKE UPDATE ON public.guides FROM pvme_runtime;
REVOKE UPDATE (publication_target) ON public.guides FROM pvme_runtime;
GRANT UPDATE (revision, publication_pin) ON public.guides TO pvme_runtime;
```

A direct-role REVOKE does not remove privileges inherited from another role or
PUBLIC. Audit effective privileges, ownership, memberships and function
security; do not make the runtime an owner or grant it schema creation,
trigger disablement or a SECURITY DEFINER bypass. Invoker triggers need the
invoking identity's underlying column permissions.
[PostgreSQL privileges](https://www.postgresql.org/docs/current/sql-grant.html) ·
[Function security](https://www.postgresql.org/docs/current/sql-createfunction.html).

Real selected-role PostgreSQL verification remains an activation blocker.
Use the actual runtime role and multiple independent clients to demonstrate
controller lease/CAS success, stale-worker refusal, canonical/pin mirror
updates and rollback atomicity. Also demonstrate denied direct authority,
settings and guide-target writes. In-process emulation does not establish
provider grants, pooled concurrency or installed-trigger behavior.

### Runtime baseline files

The content-pin provider initializes from the app's full 323 immutable
baseline JSON documents and catalog. This is an explicit new-mode exception
to server/SETUP.md's earlier statement that the runtime needs no guide JSON.
The staged Vercel api/editor.mjs function includes editor/content/*.json in
its file trace. Preserve those original app files unchanged; bundling them
does not move application authority into the content repository, seed the
database or authorize content execution. Verify the deployed function
artifact includes the complete inventory and can initialize the active
provider. No actual hosted initialization is established by the local trace
configuration.

## Compatibility and activation phases

### 1. Access and destination verification

Confirm the destination is the intended private repository, not a similarly
named project. Record its numeric repository ID, actual base branch and the
selected organization installation. Confirm the owner's app repository and
Vercel project remain unchanged. Obtain only the authorized selected-repo
access; do not change organization-wide policies or membership.

Do not write the initial seed while destination access is unresolved. Never
switch runtime routing or the Vercel Git source to work around a 404.

### 2. Compatibility before any new authority

Deploy and verify compatible routing with legacy defaults before accepting
content-pin-v1 submissions. Drain worker leases created by pre-router code
before a handoff. Backfill existing submissions/jobs with the trusted legacy
target and preserve that target as immutable submission identity.

Each job must retain the repository, installation, base branch, PR and commit
proofs that actually created it. Keep the legacy registry entry and
credentials available for reconciliation. A numeric PR collision in the
organization repository must not change an old job's destination or review
URL. Do not silently reroute an old approval.

### 3. Audited seed and shadow pin

Prepare the allowlisted data seed from the reconciled source, inspect its
file/hash audit and confirm private fields/history are absent. Preserve all
baseline guide IDs, catalog entries, current approved hashes, source credit
and licence references.

After destination access is verified, separately authorize and verify the
initial private data commit. A shadow pin binds that exact commit and manifest
digest. Exercise fetching, privacy scans, database checks and failure paths
while legacy publication remains authoritative. Local fixtures or a preview
alone do not establish end-to-end remote readiness.

### 4. Per-guide handoff

A guide remains legacy while unresolved legacy submissions or retryable
publication work exist. Do not block reading or draft saving while waiting
for handoff.

The operator handoff must atomically verify a drained guide and exact
agreement between organization data and the database's current canonical
revision/hash, then update that guide's authority. handoffGuidePublication is
an operator-only API requiring the exact target, expected revision/hash,
verified content commit, verification callback and recorded reason; it is
not a generic seed shortcut. The protected server/guide-store-operator.mjs
entry point now supplies the concrete integration; it is never imported by a
request handler and exposes no HTTP handoff route.

prepareGuideHandoff(db, root, { guideId, reason, env, appCommit, fetchStore })
returns a read-only plan and an explicit apply function. The default CLI is
read-only:

    node server/guide-store-operator.mjs GUIDE_ID 'Reviewed handoff reason'

Only after the separately approved maintenance window may the protected
operator run its explicit mutation form:

    node server/guide-store-operator.mjs --apply GUIDE_ID 'Reviewed handoff reason'

Both forms require MIGRATION_DATABASE_URL, GUIDE_STORE_STAGE=active, the exact
legacy/content bindings, read-App credentials and a reviewed immutable shadow
or active pin. Set VERCEL_GIT_COMMIT_SHA to the full reviewed app commit SHA;
do not use a floating branch name or an unrelated checkout as provenance.
The operator verifies the immutable original settings, exact remote guide hash
and revision, and drained legacy work. A replacement counts only with the
matching real submission and immutable resubmission audit. Apply then invokes
the handoff helper, which rechecks current revision/hash and pending work under
database lock. The dry plan does not reserve authority or skip the locked check.

These commands have not been executed against any remote service or production
database. A correction becomes a new reviewed submission under the intended
target; it does not reuse or rewrite an old approval. Do not globally flip
every guide merely because one shadow build passed.

The implemented bootstrap is deliberately staged: seed first, then an
owner-merged shadow-pin app PR with legacy output and no new database
authorities. The first authority handoff requires user approval and independent
staged review of a maintenance window. Freeze and drain publication work, switch
one guide's database authority, then process a genuine new approved submission
through its content PR and first active-pin app PR. The active proof requires
at least one persisted new-route approval with its owner-merged app-pin proof.

An all-baseline active cutover without a changed, newly approved guide is not
implemented and must fail closed. Do not fabricate an approval, checkpoint,
receipt or owner-merge proof to bootstrap it. The existing live reader remains
online during the window, but unrelated app builds can temporarily fail the
authority gate between the database handoff and the first active-pin app
merge. Accept and test that bounded tradeoff explicitly; a shadow build is
not permission to enter it. If the active pin cannot complete, retain the live
release, fence publication and reconcile the stored targets and pending jobs
without deleting their history.

### 5. New publication through both repositories

1. Approval freezes the submission and its target and records its durable job.
2. The worker verifies the baseline and requests an exact content PR containing
   the approved guide data and allowlisted manifest update. No private receipt
   or review discussion enters the content repository.
3. Verify the merged content commit C, its repository/base reachability, exact
   document and hashes. An approved but unmerged branch is insufficient.
4. The worker requests a deterministic personal-app update containing the
   immutable content pin and the exact private receipts for every changed
   guide represented by C. Preserve unrelated app changes.
5. The genuine Hobby owner reviews and merges that app update A. New-route
   content merge alone does not advance the editing baseline; app pin merge
   advances the canonical revision idempotently. Legacy jobs retain their
   existing timing.
6. The trusted build fetches C and runs the existing schema/receipt/database
   publication gate. Live publication waits for the production manifest and
   repository proofs, not PR creation, merge alone or preview success.

The new proof distinguishes appCommit and contentCommit. Keep commit as the
backward-compatible alias of appCommit. A public opaque source alias is
sufficient; numeric repository identities and installation bindings stay
private. Verify the app pin at the actual deployed app commit, compare app
ancestry within the app repository, and content ancestry within the content
repository. Require each terminal approval/hash to match.

An active public release uses schemaVersion 2 and publishes only proofId and
contentHash for each guide. proofId is a domain-separated SHA-256 digest of
the canonical complete private approval receipt; publication-proof.mjs owns
the domain and canonicalization. This binds the exact approval without
exposing receipt fields. Every guide in a newly emitted active release uses
this contract, including guides whose original approvals used the legacy
route. Do not emit submissionId, private UUIDs, receipt filenames, account
identifiers, audit references or review text in the new public manifest or
logs.

Historical private receipt bytes remain unchanged. Legacy reconciliation can
still recognize an old schema-less public proof using its original contract;
that compatibility does not permit leaking old receipt IDs into a newly
emitted schema-2 release. Test wrong proof/hash and strict private sentinels
before accepting the actual production-origin proof.

### 6. Ordering, retry and recovery

Extend the durable outbox and fenced leases. Serialize accepted pin
advancement per origin with a controller lease and compare-and-swap.
Aggregate all changed guides at C; a PR containing only the initiating guide
can drop an independent concurrent merge. Reject older/divergent pins even
when document hashes happen to match.

The latest accepted content commit and controller version are also mirrored
in guides.publication_pin. This is a maintenance/build fence, not merely a
content-hash check: once C2 is pending, a C1 build must be rejected even if the
guide bytes have identical hashes. The old live deployment continues serving
until the correct new build passes. Test both same-hash stale pins and
different-hash pins; do not clear or rewind controller/mirror state to make an
older build succeed.

Recover the same deterministic content/app PRs after lost acknowledgements.
An expired worker must not overwrite a newer controller or canonical
revision. Keep transient failures retryable with bounded backoff; structural,
approval, baseline and source conflicts fail closed and require their proper
review/reconciliation path.

Keep HMAC verification, exact repository/installation allowlists and the
atomic webhook delivery-record/wake transaction from PR 7. Distinct
repository routes must not become an accept-any-organization endpoint.
GitHub recommends prompt webhook acknowledgement, delivery IDs and recovery
of missed deliveries.
[Webhook practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

Do not replace durable ordering with a GitHub Actions concurrency group.
GitHub documents bounded pending queues and does not guarantee ordering by
dispatch time.
[Workflow concurrency](https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs).

## Deployment bridge alternatives and limits

The staged bridge uses the personal-app pin update and normal owner merge.

A repository_dispatch workflow can be an alternative transport, but the
workflow must exist on the default branch and its GITHUB_SHA is the default
branch SHA, not the content SHA in client_payload. Validate that payload
against authoritative repository/merge evidence. Dispatch requires target
repository permission; a workflow's ordinary GITHUB_TOKEN is limited to its
own repository.
[Dispatch semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch) ·
[Dispatch API permissions](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event) ·
[GITHUB_TOKEN scope](https://docs.github.com/en/actions/concepts/security/github_token).

A Vercel Deploy Hook is tied to a project/repository/branch and does not
transport an immutable content pin in its POST body. Its URL is a credential.
Do not update a shared latest-content environment variable and then call a
hook: concurrent merges can build a different pair than the caller intended.
[Deploy Hooks](https://vercel.com/docs/deploy-hooks).

An explicit Vercel deployment can use a Git source; the CLI documents
per-build --build-env values separately from runtime --env. These options do
not replace the pin, owner control or production authority checks. They are
not enabled by this migration stage.
[Deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment) ·
[Deployment CLI](https://vercel.com/docs/cli/deploy).

## Rollback fences

For a code regression, rebuild compatible earlier app code with the current
approved content pin and complete verification. Reverting guide wording is a
new approved revision; never rewind the approval database, remove private
receipt lineage or reuse an old approval as a rollback authorization.

Vercel Instant Rollback redirects production to an existing deployment and
does not rerun this application's build gate. It may restore older
configuration; Hobby restricts the available target to the preceding
deployment. Treat it as a separate operator exception: inspect the app/content
manifest pair, freeze publication advancement while reconciling, preserve
database history and verify both the public reader and runtime before
resuming. Do not describe a prior deployment's existence as proof that its
content is compatible with today's canonical database.
[Vercel Instant Rollback](https://vercel.com/docs/instant-rollback).

## Operator acceptance checklist

Every unchecked item remains pending; passing local tests does not check off
destination access, runtime wiring or remote publication. The eight-gate
preflight requires explicit evidence for (1) immutable historical routing,
(2) separate app/content SHA provenance, (3) unchanged DB/receipt/hash lineage,
(4) selected-repository App access, (5) signed repository-bound atomic
delivery/wake, (6) deterministic import/deployment, (7) exact live proof and
receipt confidentiality, and (8) rollback with pending work. Submit the staged
patch and this plan for that independent review before any cutover.

- [ ] Verify the reconciled code baseline and full reader/server/editor checks,
  including atomic webhook rollback and redelivery.
- [ ] Verify selected destination identity, privacy, actual base branch and
  organization installation without changing membership or organization policy.
- [ ] Verify connector access separately from both runtime publisher
  installations and protected read-only build credentials.
- [ ] Inspect the seed audit: complete baseline/catalog, approved snapshots,
  stable IDs, hashes, source credits/licences, no application/history/private
  receipts or account data.
- [ ] Verify the exact remote seed commit and manifest digest; do not use local
  synthetic validation identities as remote evidence.
- [ ] Exercise legacy pending/merged jobs, numeric PR collisions, reviewer URLs,
  retry, lost acknowledgements and supersession under frozen routing.
- [ ] Review and apply the separately authorized 002 schema and selected-role
  privilege delta; verify actual invoker triggers and denied authority/settings
  writes using real PostgreSQL and multiple clients. No grants/DDL are implied
  by this document.
- [ ] Verify the deployed function trace includes the unchanged full app
  baseline/catalog inventory required by active provider initialization.
- [ ] Drain pre-router worker leases before any per-guide authority change.
- [ ] Verify shadow fetches use the exact SHA, match original baselines and
  fail safely on access, expiry, size, tree, catalog, hash or network faults.
- [ ] Verify both selected-repository read-App installations and least
  permissions; measure remote read duration/rate limits and token renewal in
  trusted builds, including expiry and wrong-identity refusal. Mocked tests do
  not establish actual installation access.
- [ ] Obtain user and independent staged-review approval for the first
  handoff maintenance window. Demonstrate freeze/drain, exact atomic authority
  handoff, genuine newly approved submission and owner-merged active-pin proof.
  Prove all-baseline active bootstrap fails closed; test temporary unrelated
  app-build refusal and recovery while the live reader remains available.
- [ ] Demonstrate per-guide handoff only when drained and revision/hash
  agreement holds; draft saving and reading remain available.
- [ ] Demonstrate one disposable new-content approval, exact content merge,
  app pin/receipt PR, genuine owner merge and matching live app/content proof.
- [ ] Reject unmerged content, wrong repository/installation, altered receipts,
  missing overlays, mismatched app/content pairs and unapproved catalog changes.
- [ ] Exercise reordered/concurrent merges, stale app PRs, duplicate webhooks,
  lease expiry and compare-and-swap failures without losing approved guides.
- [ ] Verify content merge alone does not advance the new-route canonical
  baseline, while legacy timing remains unchanged.
- [ ] Verify failed builds retain the working release, unrelated app rebuilds
  preserve pin hashes, and backward/divergent pins are rejected. Demonstrate
  pending C2/version mirrors block stale C1 builds even with identical guide
  hashes, while the old live release remains available.
- [ ] Verify schema-2 public proofId/hash binds every exact private approval,
  including legacy-origin guides in the new release. Scan public artifacts
  and logs for private submission/receipt UUID sentinels, account identities,
  review URLs, summaries/notes, audit references and secrets; none may appear.
  Retain historical private receipts and old proof-reader compatibility.
- [ ] Exercise compatible code rollback and document the separate
  Instant Rollback exception with publication fencing.
- [ ] Obtain the architecture-audit owner's independent review of staged
  evidence before any production activation.

No organization seed write, runtime configuration change, migration execution,
policy grant, repository transfer, Vercel reconnection, Wiki/Pages sharing
change or production cutover is implied by this document.

### Explicit compatibility routing switch

An existing `GITHUB_REPOSITORY_ID` alone does not enable new routing or assume
migration 002 has run. Keep the current defaults while deploying compatible
code. After reviewing the exact legacy tuple, drain old worker leases, apply
002 under the protected operator identity and enable
`PVME_PUBLICATION_TARGET_ROUTING=enabled` with the verified app repository ID.
This permits legacy-only typed routing before organization credentials exist.
Coordinate that protected maintenance transition so typed jobs do not run
against a v1 schema or an unconfigured registry. A complete explicit
`GUIDE_STORE_STAGE` configuration also selects the typed registry; it never
makes organization publication the default for a guide. No switch was set in
production during this work.
