# Vercel build/runtime credential boundary

Reviewed 2026-11-13 for the staged guide-storage work in PR #8 (`b0b7603`), based on personal application repository `zarnab222-dev/pvme`. This is an evidence report, not an activation instruction.

The credential isolation gate remains **open**. Vercel documents separate deployment-level build and runtime inputs, but the callable deployment connector does not expose either environment map. No sentinel deployment was created, and no live result demonstrates that publisher credentials are absent from a Vercel build.

## What the primary sources establish

| Mechanism | Documented behavior | What this establishes |
| --- | --- | --- |
| Project environment variables | Project variables can be read during both the build and Vercel Function execution. Secret versus Config changes storage/readback behavior, not these execution stages. | A production-targeted publisher key in ordinary project environment settings is available to production builds. A differently named read-only key does not remove that write key. |
| CLI `vercel deploy --env` | Supplies runtime environment variables. | A documented candidate for explicitly deployed runtime inputs; this session did not exercise its server-side behavior. |
| CLI `vercel deploy --build-env` | Supplies build environment variables. | A documented candidate for explicitly deployed build inputs; this session did not exercise its server-side behavior. |
| Legacy `vercel.json` `env` and `build.env` | The documentation describes function-runtime and build-stage maps separately, while recommending migration to project settings. | These are legacy source configuration features, not evidence that the current automatic Git deployment separates credentials. Never commit a real credential as their value. |
| Current public create-deployment API and callable connector | The exposed body includes source files/Git source, project settings, target and metadata, but no `env`, `build.env` or `buildEnv` map. | The available authenticated tool cannot express the requested two-scope probe. No undocumented field was submitted. |

Sources: [Vercel environment variables](https://vercel.com/docs/environment-variables), [migration from legacy environment configuration](https://vercel.com/docs/environment-variables/managing-environment-variables#migrating-from-verceljson-env-and-buildenv), [CLI deployment flags](https://vercel.com/docs/cli/deploy#build-env), [runtime CLI flag](https://vercel.com/docs/cli/deploy#env), [legacy static configuration](https://vercel.com/docs/project-configuration/vercel-json#env), [current create-deployment API](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment).

The current [official CLI implementation](https://github.com/vercel/vercel/blob/main/packages/cli/src/commands/deploy/index.ts) also constructs separate deployment `env` and `build.env` values. This corroborates the CLI input distinction. It does not prove how every builder, install phase, framework or automatic Git deployment handles those values, and it does not add unsupported fields to the connector's callable schema.

## Current project evidence and actions

- Intended project: `prj_8tjJd67DEFubJYpyd27WCT2ExpB9`, team `team_zjxqfXFdTJrcPAEeApqI8UzV`.
- The parent task's metadata-only inventory reported production-targeted project variables and zero Preview variables. No variable values were read for this investigation. Environment targeting separates deployment environments; it does not separate a production deployment's build from its runtime.
- `vercel` was not present on the local command path. No CLI authentication, credential extraction, environment pull or installation was attempted.
- The callable `vercel_create_deployment.requestBody` schema was inspected directly. It cannot supply the two environment maps required by this experiment.
- No temporary probe branch, commit, PR or deployment was created. Creating source without a supported way to supply both scopes would not answer the gate.
- No project environment, project setting, domain, alias, protection setting, repository permission, database or production deployment was changed. No paid build option or new project was requested.
- `vercel_web_fetch_vercel_url` was not called. Its tool description says fetching creates or reuses a temporary authenticated share link, with new links expiring after 23 hours. This investigation does not authorize minting a share link. The protected-deployment skill instead recommends existing CLI authentication or a permitted origin-scoped OIDC header; neither was available for this probe.

## Consequence for the staged guide-storage code

The application has distinct read-only build helper credentials and runtime publisher credentials. That is a useful code-level separation, but it is not a proven hosting boundary.

If the write-capable GitHub App private keys are ordinary production project variables, build code and build dependencies can read them even if the intended build helper only mints read-only tokens. Secret storage and redacted logs do not establish their absence from the build environment. The existing automatic Git deployment therefore cannot currently be described as a read-only-credential build.

The same distinction applies to the database URL: code choosing read-only SQL does not prove that its underlying deployment credential has read-only privileges. That privilege and stage boundary require independent operator evidence.

The stricter promise that write-capable App keys are absent from build inputs is **unsatisfied**. The user's server-side, repository-scoped credential requirement is distinct from that additional architectural promise. The owner can review either of these approaches:

- Accept the reviewed automatic Git build and runtime as one trusted server-side principal, retain exact repository-scoped keys and token permissions, and correct any claim of separate build trust. Read-only Apps still constrain the tokens the intended build helpers use, but do not prevent trusted build code from accessing coexisting publisher keys.
- Retain the stricter separation requirement and test a supported explicit deployment mechanism through authenticated CLI or another client that exposes both scopes. Verify the non-secret experiment below before configuring any real credential delivery.

Neither choice is selected or activated here. The eight-gate review must keep the strict isolation claim open until the owner explicitly accepts a shared trust boundary or a separately tested mechanism satisfies it. This report does not change PR #8's architecture or approve a production cutover.

A future CLI test needs a supported installed CLI and an authenticated identity authorized for this exact existing project. An owner may configure that authentication through its normal protected local/CI path; no token or App key should be pasted into chat or recovered from another connector's credential store. Deployment Protection remains enabled, and authentication support is not authorization to mint a bypass or share link.

## Concrete sentinel experiment for a supported client

This is a reviewable plan only. Run it only once a supported authenticated client can provide both per-deployment scopes, and after rechecking the exact project, team, Preview-only target and current Preview variable metadata.

1. Resolve the full canonical application base commit for `1eea574`. Create one temporary private probe branch through GitHub's tree/commit APIs rooted at that exact commit. Do not push local snapshot ancestry or modify `main`.
2. Put a tiny probe in an isolated directory, with no dependencies and no application imports. Use per-deployment root/build/install/output overrides only; do not change project settings or production source.
3. Supply only synthetic, non-secret values for `PVME_RUNTIME_PROBE_SENTINEL` through the runtime input and `PVME_BUILD_PROBE_SENTINEL` through the build input. Do not supply an App key, token, database URL, session secret or existing environment value.
4. Check the same presence assertions in both the install and build commands. They should emit only boolean results and fail unless the runtime sentinel is absent and the build sentinel is present:

   ```js
   const runtimePresent = Object.hasOwn(process.env, 'PVME_RUNTIME_PROBE_SENTINEL');
   const buildPresent = Object.hasOwn(process.env, 'PVME_BUILD_PROBE_SENTINEL');
   console.log(JSON.stringify({ runtimePresent, buildPresent }));
   if (runtimePresent || !buildPresent) process.exit(1);
   ```

5. Deploy only the probe's API route. It must return presence booleans, never values, other variable names or an environment dump:

   ```js
   export default function handler(_request, response) {
     response.setHeader('Cache-Control', 'no-store');
     response.status(200).json({
       runtimePresent: Object.hasOwn(process.env, 'PVME_RUNTIME_PROBE_SENTINEL'),
       buildPresent: Object.hasOwn(process.env, 'PVME_BUILD_PROBE_SENTINEL'),
     });
   }
   ```

6. Expected evidence: install/build `{runtimePresent:false,buildPresent:true}` and deployed function `{runtimePresent:true,buildPresent:false}`. Read the exact protected Preview URL only using an already permitted authentication path. If that path is unavailable, record the runtime observation as blocked; do not create a share link or weaken protection.
7. Record the immutable probe commit, deployment ID, explicit Preview target, build result and authenticated boolean runtime result. Do not alias or promote the deployment. Clean up only this temporary probe after its evidence is preserved and cleanup is authorized.

Even a successful probe would establish only the tested deployment mechanism, builder, phases and variable injection behavior. It would not prove absence from every build artifact or service, nor change how the existing automatic Git/project-variable pipeline delivers credentials. A production deployment policy and its integration with the owner-reviewed application pin still require explicit review.
