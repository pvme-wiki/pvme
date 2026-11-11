import test from 'node:test';
import assert from 'node:assert/strict';
import { HOSTED_DOCUMENT_LIMIT_BYTES } from '../core.mjs';
import { fixture } from './harness.mjs';
import { loadSeedDocuments, seed } from '../manage.mjs';
test('complete imported catalog validates and seeds without replacing existing revisions', async t => {
  const catalog = await loadSeedDocuments();
  assert.equal(catalog.length, 323);
  assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length);
  assert.ok(catalog.every(item => Buffer.byteLength(JSON.stringify(item.document)) < HOSTED_DOCUMENT_LIMIT_BYTES));
  const f = await fixture(); t.after(() => f.db.close());
  const initial = Number((await f.db.query('SELECT count(*) FROM guides')).rows[0].count);
  assert.equal((await seed(f.db)).inserted, catalog.length - initial);
  assert.equal((await seed(f.db)).inserted, 0);
  assert.equal(Number((await f.db.query('SELECT count(*) FROM guides')).rows[0].count), 323);
  assert.equal(Number((await f.db.query('SELECT count(*) FROM guide_revisions')).rows[0].count), 323);
});
