import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { HostedAdapter } from '../../editor/src/adapter.mjs';
import * as model from '../../editor/shared/model.mjs';
import * as helpers from '../../editor/src/document.mjs';
import * as workflow from '../../editor/src/hosted-workflow.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('../../editor/content/arch-glacor-basic.json', import.meta.url), 'utf8'));
const session = id => ({ configured: true, user: { id, displayName: id, role: 'contributor' }, csrfToken: `csrf-${id}`, capabilities: { save: true, submit: true, review: false, publication: false } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

// Execute the real UI and real hosted adapter together, replacing only DOM,
// network and timers. This is behavior coverage, not a screenshot/browser test.
async function harness() {
  const elements = new Map(), stored = new Map(), calls = [];
  const noop = () => {};
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', hidden: false, open: false, classList: { toggle: noop }, close() { this.open = false; }, showModal() { this.open = true; } });
    return elements.get(selector);
  };
  let currentSession = session('account-A'), intercept = null;
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    const response = intercept?.(url, options);
    if (response !== undefined) return response;
    if (url.endsWith('/session')) return Response.json(currentSession);
    if (url.endsWith('/drafts')) return Response.json({ drafts: [] });
    if (url.includes('/guides/')) return Response.json({ document: baseline, revision: 1 });
    if (url.includes('/drafts/') && options.method === 'GET') return Response.json({ draft: null });
    throw Error(`Unexpected mock request ${options.method} ${url}`);
  };
  class BoundAdapter extends HostedAdapter { constructor() { super({ fetcher }); } }
  const context = vm.createContext({
    HostedAdapter: BoundAdapter, ...workflow, ...model, ...helpers, e: helpers.escapeHTML,
    URL, URLSearchParams, Blob, Map, Set, Date, Promise, Object, Array, String, JSON, Number, Error,
    crypto: webcrypto, structuredClone, setTimeout: () => 1, clearTimeout: noop,
    icon: () => '', rune: '', art: () => '', themeOptions: () => '', download: noop,
    location: { origin: 'https://pvme.example', pathname: '/edit/', search: '', hash: '', reload: noop },
    history: { replaceState: noop },
    document: { querySelector: element, querySelectorAll: () => [], addEventListener: noop, getElementById: element },
    window: { addEventListener: noop, scrollTo: noop },
    sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    localStorage: { getItem: () => null, setItem() { throw Error('Private UI must not write unscoped local storage'); } },
  });
  let source = fs.readFileSync(new URL('../../editor/src/hosted.mjs', import.meta.url), 'utf8');
  source = source.replace(/^import .*?;\s*$/gm, '').replace(/\nstart\(\)\.catch[\s\S]*$/, '').replaceAll('import.meta.url', '"https://pvme.example/edit/src/hosted.mjs"');
  vm.runInContext(`${source}\nglobalThis.audit = { state, adapter, connect, saveRecovery, recoveryFor, flushSave };`, context);
  const api = context.audit;
  await api.connect();
  function dirty() {
    Object.assign(api.state, { guide: { id: baseline.id }, document: { ...structuredClone(baseline), title: 'account-A-private-wording' }, savedDocument: structuredClone(baseline), baseline: structuredClone(baseline), baseRevision: 1, revision: 0, editVersion: 1, dirty: true });
  }
  return { ...api, stored, calls, element, dirty, switchTo: id => { currentSession = id ? session(id) : { configured: true, user: null, csrfToken: null, capabilities: {} }; }, intercept: fn => { intercept = fn; } };
}

test('independent: account switch clears the actual UI and adapter while keeping recovery under its original owner', async () => {
  const h = await harness(); h.dirty();
  h.state.reviews = [{ summary: 'account-A-private-review' }];
  h.state.activeReview = { summary: 'account-A-private-review' };
  h.element('#app').innerHTML = 'account-A-private-wording';
  h.element('#dialog').innerHTML = 'account-A-private-review';
  h.adapter.drafts.set(baseline.id, { private: 'account-A-private-wording' });
  h.switchTo('account-B'); await h.connect(); h.saveRecovery();
  assert.equal(h.state.session.user.id, 'account-B');
  assert.equal(h.state.document, null); assert.equal(h.state.savedDocument, null);
  assert.equal(h.state.activeReview, null); assert.equal(h.state.reviews.length, 0);
  assert.equal(h.element('#app').innerHTML, ''); assert.equal(h.element('#dialog').innerHTML, '');
  assert.equal(h.adapter.drafts.size, 0); assert.equal(h.recoveryFor(baseline.id), null);
  const privateEntries = [...h.stored].filter(([, value]) => value.includes('account-A-private-wording'));
  assert.equal(privateEntries.length, 1);
  assert.match(privateEntries[0][0], /^pvme-cloud-recovery-account-A-/);
  assert.ok(![...h.stored.keys()].some(key => key.startsWith('pvme-cloud-recovery-account-B-')));
});

test('independent: a revoked session cannot display or relabel the previous account recovery', async () => {
  const h = await harness(); h.dirty();
  h.switchTo(null); await h.connect(); h.saveRecovery();
  assert.equal(h.state.session.user, null); assert.equal(h.state.document, null);
  assert.equal(h.adapter.drafts.size, 0); assert.equal(h.recoveryFor(baseline.id), null);
  assert.ok([...h.stored.keys()].some(key => key.startsWith('pvme-cloud-recovery-account-A-')));
  assert.ok(![...h.stored.keys()].some(key => key.startsWith('pvme-cloud-recovery-signed-out-')));
});

test('independent: a real adapter late save cannot repopulate another account or claim it was saved there', async () => {
  const h = await harness(); h.dirty();
  const pending = deferred(), started = deferred(), privateDocument = structuredClone(h.state.document);
  h.intercept((url, options) => {
    if (options.method === 'PUT') { started.resolve(); return pending.promise; }
  });
  const saving = h.flushSave(); await started.promise;
  h.switchTo('account-B'); await h.connect();
  pending.resolve(Response.json({ draft: { guideId: baseline.id, version: 1, baseRevision: 1, document: privateDocument, savedAt: '2026-11-11T09:00:00.000Z' } }));
  await saving;
  assert.equal(h.state.session.user.id, 'account-B');
  assert.equal(h.state.document, null); assert.equal(h.state.savedAt, null);
  assert.equal(h.state.drafts.size, 0); assert.equal(h.adapter.drafts.size, 0);
  assert.ok(![...h.stored.keys()].some(key => key.startsWith('pvme-cloud-recovery-account-B-')));
});

test('independent: account switch while awaiting a guide blocks the subsequent old-owner mutation', async () => {
  const h = await harness();
  const pending = deferred();
  h.intercept(url => url.includes('/guides/') ? pending.promise : undefined);
  const saving = h.adapter.saveDraft(baseline.id, { baseRevision: 0, sourceRevision: 1, document: { ...baseline, title: 'account-A-private-wording' } });
  const rejection = assert.rejects(saving, error => error.code === 'session_changed');
  await settle(); h.switchTo('account-B'); await h.connect();
  pending.resolve(Response.json({ document: baseline, revision: 1 }));
  await rejection;
  assert.equal(h.calls.filter(call => call.options.method === 'PUT').length, 0);
  assert.equal(h.adapter.drafts.size, 0);
});
