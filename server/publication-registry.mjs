import fs from 'node:fs';
import path from 'node:path';
import { createGitHubApp, PublicationError } from './github.mjs';
import { createGitHubGuideStore } from './github-guide-store.mjs';
import { createPinController, validatePublicationTarget, trustedPublicationTarget } from './publication-targets.mjs';
import { loadGuideBaselines } from '../scripts/hosted-content.mjs';

export function publicationRegistryConfig(config) {
  const app = config.guideStore?.app || config.github;
  if ((!config.publicationRoutingEnabled && !config.guideStore) || !app?.id) return { publicationTargets: undefined, defaultPublicationTarget: undefined };
  const legacy = validatePublicationTarget({ pipeline: 'legacy-v1', origin: 'legacy-v1', repository: { id: app.id, owner: app.owner, repo: app.repo, base: app.base }, installationId: app.installationId });
  const publicationTargets = [{ ...legacy, appRepository: legacy.repository }];
  if (config.guideStore) {
    const content = config.guideStore.content;
    publicationTargets.push({ ...validatePublicationTarget({ pipeline: 'content-pin-v1', origin: config.guideStore.origin, repository: { id: content.id, owner: content.owner, repo: content.repo, base: content.base }, installationId: content.installationId }), appRepository: legacy.repository });
  }
  return { publicationTargets, defaultPublicationTarget: legacy };
}
export function createPublicationRegistry(db, config, { root, legacyProvider = null, guideProvider = null } = {}) {
  if (!config.github) return null;
  const legacy = legacyProvider || createGitHubApp(config.github);
  const { publicationTargets } = config;
  if (!publicationTargets) return legacy;
  let content = guideProvider;
  return {
    resolve(target) {
      const trusted = trustedPublicationTarget(target, publicationTargets);
      if (trusted.target.pipeline === 'legacy-v1') return { target: trusted.target, provider: legacy };
      if (!config.guideStore || config.guideStore.stage !== 'active') throw new PublicationError('publication_not_activated', 'Guide-repository publication is staged and has not been activated.', { retryable: true });
      if (!content) {
        if (!root) throw new PublicationError('publication_unconfigured', 'Guide publication source inventory is unavailable.');
        const pinController = createPinController(db);
        content = createGitHubGuideStore(config.guideStore, { expectedBaselines: loadGuideBaselines(root), expectedCatalogBytes: fs.readFileSync(path.join(root, 'editor/content/catalog.json')), pinController, approvalRows: ids => pinController.approvals(ids), allowActivation: true });
      }
      return { target: trusted.target, provider: content };
    },
  };
}
