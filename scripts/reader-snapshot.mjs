import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function readSnapshot(root) {
  const entries = JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'reader/reader-snapshot.json.gz')), { maxOutputLength: 75_000_000 }));
  const files = new Map();
  for (const file of entries) {
    if (!file.path || file.path.startsWith('/') || file.path.includes('\\') || file.path.split('/').some(p => !p || p === '.' || p === '..') || files.has(file.path)) throw Error('Unsafe or duplicate snapshot path');
    const data = Buffer.from(file.data, 'base64');
    if (sha256(data) !== file.sha256) throw Error(`Snapshot integrity failed: ${file.path}`);
    files.set(file.path, data);
  }
  return files;
}
export function writeFiles(files, out) {
  for (const [name, data] of files) {
    const target = path.join(out, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}
