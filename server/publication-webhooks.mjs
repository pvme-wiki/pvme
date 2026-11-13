import { createHmac } from 'node:crypto';
import { equalSecret, fail } from './core.mjs';
import { publicationTargetDescriptor } from './publication-targets.mjs';

export function authenticatePublicationWebhook(config, raw, signature, delivery) {
  const legacy = config.github;
  const contexts = legacy ? [{ origin: 'legacy-v1', repository: { ...legacy, id: config.guideStore?.app.id || legacy.id }, secret: legacy.webhookSecret, legacy: true }] : [];
  if (config.guideStore) contexts.push({ origin: config.guideStore.origin, repository: config.guideStore.content, secret: config.guideStore.content.webhookSecret, legacy: false });
  const signed = contexts.filter(context => equalSecret(`sha256=${createHmac('sha256', context.secret).update(raw).digest('hex')}`, signature));
  if (!signed.length) fail(401, 'invalid_signature', 'Invalid webhook signature.');
  if (!/^[a-zA-Z0-9-]{10,100}$/.test(delivery || '')) fail(400, 'invalid_delivery', 'Invalid webhook delivery.');
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'invalid_json', 'Invalid webhook body.'); }
  const context = signed.find(({ repository }) => payload.repository?.private === true && payload.repository.full_name?.toLowerCase() === `${repository.owner}/${repository.repo}`.toLowerCase() && String(payload.installation?.id) === String(repository.installationId) && (!repository.id || payload.repository.id === Number(repository.id)));
  if (!context) fail(403, 'invalid_repository', 'Unexpected webhook repository or installation.');
  const entries = config.publicationTargets instanceof Map ? [...config.publicationTargets.values()] : config.publicationTargets;
  const targets = entries?.map(publicationTargetDescriptor).filter(target => context.legacy || (target.origin === context.origin && Number(target.repository.id) === Number(context.repository.id) && target.installationId === String(context.repository.installationId)));
  return {
    // Preserve the existing app delivery key across compatibility deployment.
    // Content deliveries have an independent namespace, even if IDs collide.
    deliveryId: context.legacy ? delivery : `${context.origin}:${context.repository.id}:${context.repository.installationId}:${delivery}`,
    wakeOptions: targets ? { targets, includeLegacyUnbound: context.legacy } : undefined,
  };
}
