# Private GitHub App setup for staged guide storage

This is an unapplied owner-review bundle for PR #8. No App has been registered, installed or granted access by this bundle. No credential has been generated or stored. Production remains on the personal application repository and its existing publisher installation.

The companion [nonsecret settings specification](guide-storage-app-settings.json) contains three proposed registrations. Its unresolved URLs and IDs are deliberately `null`; it is not a submit-ready GitHub manifest. Names are proposals, and their global availability has not been checked.

## Resolve these inputs first

- Confirm authorized access to the private `pvme-wiki/guides` repository. The connector's 404 does not establish whether the repository is absent or merely inaccessible. Record the actual numeric repository ID, owner, name and base branch from authorized GitHub metadata.
- Confirm the corresponding private `zarnab222-dev/pvme` repository metadata without changing its existing publisher settings.
- Select and verify a dedicated HTTPS staging origin. Configure staging `APP_ORIGIN` to that exact origin, with a staging database and staging credentials. No staging origin is selected in this document.
- Verify that GitHub can reach the staging webhook route without a browser sign-in challenge. Do not guess a Vercel preview hostname, reuse the production origin, add wildcard origin exceptions or disable deployment protection to make this pass.
- Resolve the [Vercel credential-boundary gate](vercel-credential-boundary.md) before placing new keys into a deployment/build path. Separate GitHub App registrations do not demonstrate that normal Vercel Git builds cannot read publisher keys in project environment variables.

The current PR #8 preview is protected by Vercel Authentication. GitHub delivery to its webhook route is therefore not established by browser access or by passing local HMAC tests. This is a remote integration blocker. Leave the webhook URL unresolved until the owner approves an exact reachable HTTPS receiver and verifies both deployment-protection behavior and the server's exact `APP_ORIGIN` host check. The receiver must validate HMAC and repository/installation identity without exposing private review data. Do not mint share/bypass links, relax protection, or point a new hook at production as a shortcut.

The ChatGPT GitHub connector's installation belongs to a different App from the runtime publishers/readers. Its installation ID is not a runtime setup value. Opaque secret-setting metadata does not verify the legacy publisher's actual owner, App or installation identity; obtain those bindings from the owner's App settings or authorized runtime-App metadata. Do not read back existing secret values merely to fill this bundle.

An App's OAuth callback URL is different from its webhook URL. These Apps use installation authentication, not user OAuth. Leave user authorization callback URLs, device flow and setup redirects unused. The publisher webhook is the exact verified staging origin followed by `/api/editor/webhooks/github`; it must agree with staging `APP_ORIGIN`.

## Three separate private registrations

| Proposed App name | Registration owner | Selected installation repository | Repository permissions | Webhooks |
| --- | --- | --- | --- | --- |
| Unofficial PvME Guide Publisher | `pvme-wiki` organization | `pvme-wiki/guides` only | Contents: write; Pull requests: write; Metadata: read | Active; only `push` and `pull_request`; verified staging webhook URL |
| Unofficial PvME Guide Reader | `pvme-wiki` organization | `pvme-wiki/guides` only | Contents: read; Pull requests: read; Metadata: read | Inactive; no events or webhook URL |
| Unofficial PvME App Reader | `zarnab222-dev` personal account | `zarnab222-dev/pvme` only | Contents: read; Pull requests: read; Metadata: read | Inactive; no events or webhook URL |

Each description must identify this as an independent, unofficial guide-storage project, not an official PvME App. Keep each registration private: GitHub's owner-only visibility setting. Do not make an App public to install it across accounts. The two organization-owned Apps can be installed on their owning organization; the personal App can be installed on its owning personal account. [Private App ownership and installation](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

For every App, leave all other repository permissions at no access, and request no organization, enterprise or account permissions. In particular, do not add member access, administration, workflows, Actions, emails or billing permissions. Do not transfer ownership, change repository visibility, or alter the existing personal publisher App. GitHub recommends selecting the permissions actually needed by the implementation. [Permission selection](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

## Owner registration and installation sequence

Use manual registration for this stage. In the appropriate owner's GitHub settings, open Developer settings, then GitHub Apps and the new-App form. Confirm the account context before submitting. The organization registrations require an authorized organization owner or App manager. Use the name, description and permission rows above; set the homepage to the owner-approved staging site once that site is verified. If a proposed name is unavailable, choose a reviewed name that retains the unofficial affiliation and fits GitHub's 34-character limit. [Registration procedure](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

For the guide publisher:

1. Leave user OAuth authorization, device flow, user callback URLs and setup redirects unused.
2. Enable webhooks, enter the exact verified staging webhook URL, retain TLS verification, and select only the two listed events.
3. The owner creates a distinct high-entropy webhook secret of at least 32 characters and enters it privately into GitHub and the staging server's `GUIDE_STORE_WEBHOOK_SECRET` configuration. No example secret is supplied here.
4. Review the complete permissions and private visibility before creating the registration.

For each reader, disable webhooks and leave the webhook URL and secret empty. Do not subscribe to events or enable user authorization. GitHub documents disabling webhooks for authentication-only Apps without supplying a webhook URL. [Webhook settings](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps).

After each registration, use its actual Install App control. Select only the one repository in its row. Do not choose all repositories. Verify the installation's account and selected-repository list before granting access; record the actual App ID and installation ID afterward. This bundle intentionally contains no constructed installation link or guessed ID. [Selected-repository installation](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

A settings/permissions change after installation can require another approval. Recheck the installed permissions, rather than assuming that editing a registration changed its existing grants.

## Private credential mapping

The owner generates a separate RSA private key for each new App in GitHub's credential settings and stores it through the approved server-configuration UI. Keep PEM files, webhook secrets, JWTs and installation tokens out of chat, source files, screenshots, URLs, logs and the seed archive. GitHub private keys do not expire automatically, so keep their fingerprint and revocation procedure in the owner's private operational records. [Private-key handling](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

| New registration | Server configuration keys populated privately |
| --- | --- |
| Guide publisher | `GUIDE_STORE_APP_ID`, `GUIDE_STORE_INSTALLATION_ID`, `GUIDE_STORE_APP_PRIVATE_KEY`, `GUIDE_STORE_WEBHOOK_SECRET` |
| Guide reader | `GUIDE_STORE_READ_APP_ID`, `GUIDE_STORE_READ_INSTALLATION_ID`, `GUIDE_STORE_READ_PRIVATE_KEY` |
| Personal app reader | `GUIDE_STORE_APP_READ_APP_ID`, `GUIDE_STORE_APP_READ_INSTALLATION_ID`, `GUIDE_STORE_APP_READ_PRIVATE_KEY` |

The guide repository binding also needs verified `GUIDE_STORE_REPOSITORY_ID`, `GUIDE_STORE_OWNER`, `GUIDE_STORE_REPO` and `GUIDE_STORE_BASE_BRANCH`. The app read binding uses verified `GITHUB_REPOSITORY_ID` and the existing app owner/repository/base configuration. Do not overwrite the legacy publisher's `GITHUB_APP_ID`, installation ID, key or webhook secret with reader credentials.

The OAuth client ID/client secret created by GitHub App registration are not used by this installation-authentication implementation. Do not add them to the application configuration. Do not introduce a static installation-token secret as a substitute for the renewable reader Apps.

The reader provider requests only one verified numeric repository ID and Contents/Pull requests read permissions. It checks private repository identity, App/installation/account binding, selected-repository mode, permitted scopes and expiry before caching a token. These checks need actual staged verification after owner setup; local tests do not prove real grants. [Installation-token scope and lifetime](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

Do not install keys in untrusted preview environments. Ordinary Vercel project environment settings are not proof of build/runtime isolation. The [credential-boundary report](vercel-credential-boundary.md) remains the decision record for that unresolved gate.

## Acceptance evidence before any cutover request

- Record all three actual registration owners, App IDs, installation IDs and selected repository IDs using authorized metadata, with no secret values in the review report.
- Confirm the two reader registrations have only the three read permissions, selected-repository mode and no webhook subscriptions. Exercise token renewal and wrong-installation rejection through trusted staging configuration.
- Confirm the publisher has only the listed write/read permissions and its staging route matches `APP_ORIGIN` exactly. Verify a signed, repository-bound staging delivery when that test action is separately authorized. An initial App ping alone does not establish repository access or publication success.
- Test invalid signatures, wrong repository/installation identities and replayed deliveries without logging raw payloads. Webhook delivery only wakes checks; it does not approve or publish content. [Signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
- Revalidate the pinned seed, complete guide inventory, database approval gate, pending jobs and rollback procedures. Keep the stage shadow and authority handoff unapplied during setup.
- Resolve credential isolation and every other migration gate, then present the exact verified staging result to Zarnab for explicit cutover approval. Registration/install consent does not authorize production migration.

## Manifest reference and current tooling limit

GitHub's manifest format supports a private flag, permission/event defaults and webhook configuration. Publisher defaults would be `contents: write`, `pull_requests: write`, `metadata: read`, with events `push` and `pull_request`; reader defaults are the same three permissions at read level with no events. The JSON companion records these exact settings but keeps unresolved URL/identity inputs null.

The manifest flow registers an App and returns a temporary code that is exchanged for sensitive configuration. It therefore needs an implemented secure registration redirect/conversion flow; the existing webhook endpoint is not that flow. This repository has not added one, and no available tool here registers or installs Apps. Do not POST the settings specification to GitHub or treat a placeholder as a verified callback. Manual owner registration avoids inventing such a service. [Manifest protocol and fields](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
