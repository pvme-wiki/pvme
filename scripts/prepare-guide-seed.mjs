import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadHostedContent } from './hosted-content.mjs';
import { documentHash } from '../server/core.mjs';
import { GUIDE_STORE_ORIGIN, GUIDE_STORE_MANIFEST, GUIDE_STORE_DOCUMENTATION, guideStoreSha256, serializeGuideManifest, validateGuideStore, isGuideStorePath, GUIDE_STORE_LIMITS, guideStoreBytes } from '../server/content-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
function regularBytes(file) { if (!fs.lstatSync(file).isFile()) throw Error('A seed input is not a regular file.'); return fs.readFileSync(file); }
/** Read only known application content paths; never copy Git history or review files. */
export function buildGuideSeed(root = ROOT) {
  const hosted = loadHostedContent(root);
  const catalogBytes = regularBytes(path.join(root, 'editor/content/catalog.json'));
  const files = new Map([...GUIDE_STORE_DOCUMENTATION].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  files.set('baselines/catalog.json', catalogBytes);
  const manifest = { schemaVersion: 1, origin: GUIDE_STORE_ORIGIN, catalog: { path: 'baselines/catalog.json', sha256: guideStoreSha256(catalogBytes) }, baselines: {}, guides: {} };
  for (const id of [...hosted.baseline.keys()].sort()) {
    const bytes = regularBytes(path.join(root, 'editor/content', `${id}.json`));
    files.set(`baselines/${id}.json`, bytes);
    manifest.baselines[id] = { path: `baselines/${id}.json`, sha256: guideStoreSha256(bytes), contentHash: documentHash(hosted.baseline.get(id)) };
  }
  for (const id of [...hosted.published.keys()].sort()) {
    const entry = hosted.published.get(id), bytes = regularBytes(path.join(root, 'content/guides', `${id}.json`));
    files.set(`guides/${id}.json`, bytes);
    manifest.guides[id] = { path: `guides/${id}.json`, sha256: guideStoreSha256(bytes), contentHash: entry.contentHash, baselineHash: entry.receipt.baselineHash, revision: entry.receipt.baseRevision + 1 };
  }
  const manifestBytes = serializeGuideManifest(manifest);
  files.set(GUIDE_STORE_MANIFEST, manifestBytes);
  // The synthetic shadow identity is local validation context only. It is not a
  // remote repository assertion and is never written to the seed payload.
  const pin = { schemaVersion: 1, mode: 'shadow', origin: GUIDE_STORE_ORIGIN, repository: { id: 1, owner: 'local', repo: 'seed-validation', base: 'main' }, contentCommit: '0'.repeat(40), manifestSha256: guideStoreSha256(manifestBytes), guideIds: [] };
  validateGuideStore({ pin, manifestBytes, files, expectedBaselines: hosted.baseline, expectedCatalogBytes: catalogBytes });
  return { manifest, manifestBytes, files, expectedBaselines: hosted.baseline, catalogBytes, summary: { baselineCount: hosted.baseline.size, overlayCount: hosted.published.size, fileCount: files.size, totalBytes: [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0), manifestSha256: pin.manifestSha256, includesPrivateReceipts: false } };
}
function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512);
  const field = (offset, length, value) => header.write(value, offset, length, 'ascii');
  field(0, 100, name); field(100, 8, '0000644\0'); field(108, 8, '0000000\0'); field(116, 8, '0000000\0');
  field(124, 12, size.toString(8).padStart(11, '0') + '\0'); field(136, 12, '00000000000\0');
  header.fill(32, 148, 156); field(156, 1, type); field(257, 6, 'ustar\0'); field(263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0); field(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}
function tarEntry(name, bytes, type) { return [tarHeader(name, bytes.length, type), bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]; }
/** Deterministic data-only tar.gz: regular files, zero timestamps and sorted paths. */
export function archiveGuideSeed(files) {
  if (!(files instanceof Map) || files.size > GUIDE_STORE_LIMITS.files || [...files.keys()].some(file => !isGuideStorePath(file))) throw Error('The guide archive contains unsupported paths.');
  const entries = []; let index = 0, total = 0;
  for (const [file, value] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = guideStoreBytes(value); total += bytes.length; if (bytes.length > GUIDE_STORE_LIMITS.fileBytes || total > GUIDE_STORE_LIMITS.totalBytes) throw Error('The guide archive exceeds its supported size.');
    let name = file;
    if (Buffer.byteLength(file) > 100) {
      const record = ` path=${file}\n`; let length = Buffer.byteLength(record) + 1;
      while (length !== Buffer.byteLength(String(length) + record)) length = Buffer.byteLength(String(length) + record);
      entries.push(...tarEntry(`PaxHeaders/${index}`, Buffer.from(String(length) + record), 'x')); name = `payload-${index}`;
    }
    entries.push(...tarEntry(name, bytes, '0')); index++;
  }
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]), { level: 9 });
}
export function writeGuideSeed(seed, output, { root = ROOT } = {}) {
  const runtime = path.resolve(root, '.runtime'), destination = path.resolve(output);
  if (!destination.startsWith(runtime + path.sep) || fs.existsSync(destination)) throw Error('Choose a new output directory inside this worktree’s ignored .runtime directory.');
  const relative = path.relative(path.resolve(root), destination).split(path.sep);
  let current = path.resolve(root);
  for (const part of relative) { current = path.join(current, part); if (fs.existsSync(current) && !fs.lstatSync(current).isDirectory()) throw Error('The output parent must contain only regular directories.'); }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const payload = path.join(destination, 'payload'); fs.mkdirSync(payload, { mode: 0o700 });
  for (const [file, bytes] of seed.files) { const target = path.join(payload, file); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); }
  const archive = archiveGuideSeed(seed.files); fs.writeFileSync(path.join(destination, 'guide-seed.tar.gz'), archive, { flag: 'wx', mode: 0o600 });
  const audit = { ...seed.summary, archiveSha256: guideStoreSha256(archive), archiveBytes: archive.length, files: [...seed.files].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: guideStoreSha256(bytes) })) };
  fs.writeFileSync(path.join(destination, 'seed-audit.json'), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...audit, output: destination };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); if (args.length && (args.length !== 2 || args[0] !== '--output')) throw Error('Use no arguments for a dry run, or --output PATH under .runtime.');
    const seed = buildGuideSeed();
    const report = args.length ? writeGuideSeed(seed, args[1]) : { dryRun: true, ...seed.summary };
    const { files: _files, ...summary } = report; console.log(JSON.stringify(summary));
  } catch (error) { console.error(error.message?.startsWith('Use ') || error.message?.startsWith('Choose ') ? error.message : 'Guide seed validation failed. No remote changes were made.'); process.exitCode = 1; }
}
