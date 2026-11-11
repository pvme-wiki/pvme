import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSnapshot, sha256 } from './reader-snapshot.mjs';
import { patchHtml, guideSpans } from './patch-reader-html.mjs';
const root = path.resolve(import.meta.dirname, '..');
const files = readSnapshot(root);
test('all recovered files and 352 article instances retain verified bytes', () => {
  assert.equal(files.size, 700);
  const { pages } = JSON.parse(fs.readFileSync(path.join(root, 'reader/reader-slots.json')));
  assert.equal(pages.length, 352);
  for (const slot of pages) {
    const data = files.get(slot.pagePath), offsets = slot.byteOffsets;
    assert.equal(sha256(data), slot.originalPageSha256);
    assert.equal(sha256(data.subarray(offsets.bodyStart, offsets.attributionStart)), slot.bodySha256);
  }
  assert.equal(pages.filter(p => p.slotKind === 'inline').length, 12);
  assert.equal([...files.keys()].filter(p => p.endsWith('.wiki')).length, 323);
});
test('night chrome adapter is idempotent and leaves source article bytes untouched', () => {
  let pages = 0, protectedCount = 0;
  for (const [name, data] of files) {
    if (!name.endsWith('.html')) continue;
    const original = data.toString('utf8'), patched = patchHtml(original);
    assert.equal(patchHtml(patched), patched, name);
    const before = guideSpans(original).map(([start, end]) => original.slice(start, end));
    const after = guideSpans(patched).map(([start, end]) => patched.slice(start, end));
    assert.deepEqual(after, before, name);
    assert.match(patched, /data-theme-control/); assert.match(patched, /assets\/night-mode.js/);
    protectedCount += before.length; pages++;
  }
  assert.equal(pages, 360); assert.equal(protectedCount, 352);
});
