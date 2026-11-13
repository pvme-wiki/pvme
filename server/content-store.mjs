import { createHash } from 'node:crypto';
import { assertDocument } from '../editor/shared/model.mjs';
import { canonical, documentHash, HOSTED_DOCUMENT_LIMIT_BYTES } from './core.mjs';

export const GUIDE_STORE_ORIGIN = 'guides-v1';
export const GUIDE_STORE_MANIFEST = 'manifest.json';
export const GUIDE_STORE_LIMITS = Object.freeze({ files: 1100, guides: 500, fileBytes: 5_500_000, totalBytes: 100_000_000, manifestBytes: 750_000 });
export const GUIDE_STORE_README = '# PvME guide content\n\nThis is an independent guide-storage project, not an official PvME repository.\n\nThis repository stores immutable imported guide baselines and reviewed guide snapshots. The application and deployment configuration live separately.\n\nSource attribution, source URLs, captured-source hashes and existing licence references remain in each guide document. Private account data, review receipts, review notes, application code and deployment credentials are not part of this payload.\n';
export const GUIDE_STORE_LICENSE_REFERENCES = '# Source licence references\n\nThe imported guide text identifies PvME contributors and CC BY-NC-SA 4.0 in each document. Retain those document-level attributions and source links.\n\n- Guide text licence: https://creativecommons.org/licenses/by-nc-sa/4.0/\n- Upstream source licence reference: https://github.com/pvme/pvme-guides/blob/master/LICENSE\n\nMedia and game imagery retain their existing source rights; this reference file does not apply a new licence to them.\n';
export const GUIDE_STORE_DOCUMENTATION = new Map([['README.md', Buffer.from(GUIDE_STORE_README)], ['LICENSE-REFERENCES.md', Buffer.from(GUIDE_STORE_LICENSE_REFERENCES)]]);
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,100}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export class ContentStoreError extends Error { constructor(code, message) { super(message); this.name = 'ContentStoreError'; this.code = code; } }
const reject = (code, message) => { throw new ContentStoreError(code, message); };
export const guideStoreSha256 = value => createHash('sha256').update(value).digest('hex');
export function guideStoreBytes(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array || typeof value === 'string') return Buffer.from(value);
  reject('invalid_bytes', 'Guide content must be UTF-8 file bytes.');
}
function exact(value, keys, message) {
  if (!plain(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) reject('invalid_contract', message);
}
function hash(value) { if (!HASH.test(value || '')) reject('invalid_hash', 'Guide content has an invalid SHA-256 digest.'); }
function ids(value, message) {
  if (!Array.isArray(value) || value.length > GUIDE_STORE_LIMITS.guides || value.some(id => !ID.test(id || '')) || value.some((id, index) => index && value[index - 1] >= id)) reject('invalid_inventory', message);
}
function sameIds(a, b) { return canonical(a) === canonical(b); }
export function validateGuideRepository(repository) {
  exact(repository, ['id', 'owner', 'repo', 'base'], 'The guide repository identity is incomplete.');
  if (!Number.isSafeInteger(repository.id) || repository.id < 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository.owner || '') || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository.repo || '') || !/^[A-Za-z0-9][A-Za-z0-9_/-]{0,150}$/.test(repository.base || '') || repository.base.split('/').some(part => !part || part === '.' || part === '..') || repository.base.includes('//')) reject('invalid_repository', 'The guide repository identity is invalid.');
  return structuredClone(repository);
}
export function validateGuidePin(pin, { expectedRepository } = {}) {
  exact(pin, ['schemaVersion', 'mode', 'origin', 'repository', 'contentCommit', 'manifestSha256', 'guideIds'], 'The guide content pin has unsupported fields.');
  if (pin.schemaVersion !== 1 || pin.origin !== GUIDE_STORE_ORIGIN || !['shadow', 'active'].includes(pin.mode) || !SHA.test(pin.contentCommit || '')) reject('invalid_pin', 'The guide content pin is invalid.');
  hash(pin.manifestSha256);
  const repository = validateGuideRepository(pin.repository);
  if (expectedRepository && canonical(repository) !== canonical(validateGuideRepository(expectedRepository))) reject('repository_mismatch', 'The guide content pin points at a different repository.');
  ids(pin.guideIds, 'Guide authority IDs must be sorted and unique.');
  return { ...structuredClone(pin), repository };
}
function parseFile(bytes, maximum = GUIDE_STORE_LIMITS.fileBytes) {
  const value = guideStoreBytes(bytes);
  if (!value.length || value.length > maximum) reject('file_limit', 'A guide content file exceeds its supported size.');
  // Buffer's replacement decoding would silently alter malformed UTF-8.
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { reject('invalid_utf8', 'A guide content file is not valid UTF-8.'); }
  try { return JSON.parse(text); } catch { reject('invalid_json', 'A guide content file is not valid JSON.'); }
}
export function validateGuideManifest(manifest, { expectedBaselines, expectedCatalogBytes, guideIds } = {}) {
  exact(manifest, ['schemaVersion', 'origin', 'catalog', 'baselines', 'guides'], 'The guide content manifest has unsupported fields.');
  if (manifest.schemaVersion !== 1 || manifest.origin !== GUIDE_STORE_ORIGIN || !(expectedBaselines instanceof Map) || !expectedBaselines.size || expectedBaselines.size > GUIDE_STORE_LIMITS.guides) reject('invalid_manifest', 'The guide content manifest requires the complete application baseline inventory.');
  exact(manifest.catalog, ['path', 'sha256'], 'The guide catalog declaration is invalid.');
  hash(manifest.catalog.sha256);
  const catalogBytes = guideStoreBytes(expectedCatalogBytes);
  if (manifest.catalog.path !== 'baselines/catalog.json' || manifest.catalog.sha256 !== guideStoreSha256(catalogBytes)) reject('catalog_mismatch', 'The guide catalog differs from the sealed application catalog.');
  const catalog = parseFile(catalogBytes);
  if (!Array.isArray(catalog) || catalog.some(item => !plain(item) || !ID.test(item.id || '') || item.file !== `${item.id}.json`) || new Set(catalog.map(item => item.id)).size !== catalog.length || !sameIds(catalog.map(item => item.id).sort(), [...expectedBaselines.keys()].sort())) reject('catalog_mismatch', 'The guide catalog does not preserve the complete application inventory.');
  if (!plain(manifest.baselines) || !plain(manifest.guides) || !sameIds(Object.keys(manifest.baselines).sort(), [...expectedBaselines.keys()].sort())) reject('baseline_mismatch', 'The guide store does not preserve every application baseline.');
  const overlayIds = Object.keys(manifest.guides).sort(); ids(overlayIds, 'The guide overlay inventory is invalid.');
  if (guideIds !== undefined) { ids(guideIds, 'Guide authority IDs must be sorted and unique.'); if (guideIds.some(id => !expectedBaselines.has(id))) reject('authority_mismatch', 'A pinned guide authority ID is absent from the baseline inventory.'); }
  for (const [id, expected] of expectedBaselines) {
    const entry = manifest.baselines[id];
    exact(entry, ['path', 'sha256', 'contentHash'], 'A guide baseline declaration has unsupported fields.'); hash(entry.sha256); hash(entry.contentHash);
    if (!ID.test(id) || expected?.id !== id || entry.path !== `baselines/${id}.json` || entry.contentHash !== documentHash(expected)) reject('baseline_mismatch', 'A guide baseline differs from its immutable application document.');
  }
  for (const [id, entry] of Object.entries(manifest.guides)) {
    exact(entry, ['path', 'sha256', 'contentHash', 'baselineHash', 'revision'], 'A guide overlay declaration has unsupported fields.'); hash(entry.sha256); hash(entry.contentHash); hash(entry.baselineHash);
    if (!expectedBaselines.has(id) || entry.path !== `guides/${id}.json` || !Number.isSafeInteger(entry.revision) || entry.revision < 2 || (entry.revision === 2 && entry.baselineHash !== manifest.baselines[id].contentHash)) reject('invalid_overlay', 'A guide overlay has invalid lineage metadata.');
  }
  return { manifest: structuredClone(manifest), catalog };
}
export function isGuideStorePath(file) { return typeof file === 'string' && (file === GUIDE_STORE_MANIFEST || GUIDE_STORE_DOCUMENTATION.has(file) || file === 'baselines/catalog.json' || /^(?:baselines|guides)\/[a-z0-9][a-z0-9-]{0,100}\.json$/.test(file)); }
export function guideStorePaths(manifest) {
  return [GUIDE_STORE_MANIFEST, ...GUIDE_STORE_DOCUMENTATION.keys(), manifest.catalog.path, ...Object.values(manifest.baselines).map(entry => entry.path), ...Object.values(manifest.guides).map(entry => entry.path)].sort();
}
export function validateGuideStore({ pin, manifestBytes, files, expectedBaselines, expectedCatalogBytes, expectedRepository } = {}) {
  const checkedPin = validateGuidePin(pin, { expectedRepository });
  const rawManifest = guideStoreBytes(manifestBytes);
  if (rawManifest.length > GUIDE_STORE_LIMITS.manifestBytes || guideStoreSha256(rawManifest) !== checkedPin.manifestSha256) reject('manifest_mismatch', 'The fetched manifest differs from the immutable content pin.');
  const { manifest, catalog } = validateGuideManifest(parseFile(rawManifest, GUIDE_STORE_LIMITS.manifestBytes), { expectedBaselines, expectedCatalogBytes, guideIds: checkedPin.guideIds });
  if (!(files instanceof Map) || files.size > GUIDE_STORE_LIMITS.files || !sameIds([...files.keys()].sort(), guideStorePaths(manifest))) reject('unexpected_files', 'The guide store contains missing or unexpected files.');
  const verifiedFiles = new Map(); let totalBytes = 0;
  for (const [file, value] of files) { const bytes = guideStoreBytes(value); totalBytes += bytes.length; if (bytes.length > GUIDE_STORE_LIMITS.fileBytes || totalBytes > GUIDE_STORE_LIMITS.totalBytes) reject('payload_limit', 'The guide store exceeds its bounded payload size.'); verifiedFiles.set(file, bytes); }
  if (!verifiedFiles.get(GUIDE_STORE_MANIFEST).equals(rawManifest)) reject('manifest_mismatch', 'The manifest file differs from the validated content pin.');
  if (!verifiedFiles.get(manifest.catalog.path).equals(guideStoreBytes(expectedCatalogBytes))) reject('catalog_mismatch', 'The fetched catalog differs from the sealed application catalog.');
  for (const [file, expected] of GUIDE_STORE_DOCUMENTATION) if (!verifiedFiles.get(file).equals(expected)) reject('documentation_mismatch', 'Guide storage documentation differs from its independent scope and licence references.');
  const baseline = new Map(), guides = new Map();
  for (const [id, entry] of Object.entries(manifest.baselines)) {
    const bytes = verifiedFiles.get(entry.path); if (guideStoreSha256(bytes) !== entry.sha256) reject('file_hash_mismatch', 'A guide baseline file differs from its manifest.');
    const document = parseFile(bytes); assertDocument(document);
    if (document.id !== id || documentHash(document) !== entry.contentHash || canonical(document) !== canonical(expectedBaselines.get(id))) reject('baseline_mismatch', 'The fetched guide baseline differs from the immutable application document.');
    baseline.set(id, document);
  }
  for (const [id, entry] of Object.entries(manifest.guides)) {
    const bytes = verifiedFiles.get(entry.path); if (guideStoreSha256(bytes) !== entry.sha256) reject('file_hash_mismatch', 'A guide overlay file differs from its manifest.');
    const document = parseFile(bytes); assertDocument(document, { baseline: baseline.get(id) });
    if (document.id !== id || documentHash(document) !== entry.contentHash || Buffer.byteLength(JSON.stringify(document)) > HOSTED_DOCUMENT_LIMIT_BYTES) reject('overlay_mismatch', 'The fetched guide overlay differs from its manifest or document budget.');
    guides.set(id, { document, contentHash: entry.contentHash, baselineHash: entry.baselineHash, revision: entry.revision });
  }
  return { pin: checkedPin, manifest, catalog, baseline, guides, files: verifiedFiles };
}

/** Stable JSON bytes prevent object-key ordering from changing a pinned blob. */
export const serializeGuideFile = value => Buffer.from(`${JSON.stringify(JSON.parse(canonical(value)), null, 2)}\n`);
export const serializeGuideManifest = serializeGuideFile;
export function updateGuideManifest(manifest, { guideId, document, baselineHash, revision }, options) {
  validateGuideManifest(manifest, options);
  if (!ID.test(guideId || '') || document?.id !== guideId || !options.expectedBaselines.has(guideId)) reject('invalid_overlay', 'The publication guide is absent from the immutable baseline inventory.');
  assertDocument(document, { baseline: options.expectedBaselines.get(guideId) });
  const previous = manifest.guides[guideId];
  if (baselineHash !== (previous?.contentHash || manifest.baselines[guideId].contentHash) || revision !== (previous?.revision || 1) + 1) reject('source_conflict', 'The guide publication does not follow the current content-store revision.');
  const guideBytes = serializeGuideFile(document);
  if (Buffer.byteLength(JSON.stringify(document)) > HOSTED_DOCUMENT_LIMIT_BYTES || guideBytes.length > GUIDE_STORE_LIMITS.fileBytes) reject('file_limit', 'The publication guide exceeds the supported document size.');
  const updated = structuredClone(manifest);
  updated.guides[guideId] = { path: `guides/${guideId}.json`, sha256: guideStoreSha256(guideBytes), contentHash: documentHash(document), baselineHash, revision };
  validateGuideManifest(updated, options);
  const manifestBytes = serializeGuideManifest(updated);
  return { manifest: updated, manifestBytes, guideBytes, manifestSha256: guideStoreSha256(manifestBytes) };
}
