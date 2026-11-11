import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Preference lifecycle tests use the real classic script and explicit DOM/media
// doubles. Contrast tests cover authored token pairs, not a full rendered audit.
const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const source = read('src/night-mode.js');
const css = read('src/night-mode.css');
const themes = read('src/themes.css');
class Events {
  handlers = new Map();
  addEventListener(name, fn) { this.handlers.set(name, [...(this.handlers.get(name) || []), fn]); }
  fire(name, event = {}) { for (const fn of this.handlers.get(name) || []) fn(event); }
}
function setup({ dark = false, stored = null, blocked = false, ready = 'loading' } = {}) {
  const document = new Events();
  document.documentElement = { dataset: {} };
  document.readyState = ready;
  const labels = [{ hidden: true }, { hidden: true }];
  const controls = labels.map(label => Object.assign(new Events(), { value: '', closest: () => label }));
  document.querySelectorAll = query => { assert.equal(query, '[data-theme-control]'); return controls; };
  const window = new Events();
  const media = Object.assign(new Events(), { matches: dark });
  window.matchMedia = query => { assert.equal(query, '(prefers-color-scheme: dark)'); return media; };
  const store = new Map(stored === null ? [] : [['pvme-theme', stored]]);
  let writes = 0;
  const localStorage = {
    getItem(key) { if (blocked) throw new Error('Storage unavailable'); return store.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error('Storage unavailable'); writes++; store.set(key, value); },
  };
  vm.runInNewContext(source, { document, window, localStorage }, { timeout: 1000 });
  return { document, window, media, controls, labels, store, writes: () => writes, mode: () => document.documentElement.dataset,
    connect() { document.fire('DOMContentLoaded'); },
    choose(value) { controls[0].value = value; controls[0].fire('change'); },
    system(value) { media.matches = value; media.fire('change'); },
  };
}
for (const dark of [false, true]) {
  const test = setup({ dark });
  assert.equal(test.mode().theme, 'dark', 'First visit opens in Night before DOM ready, regardless of OS');
  assert.equal(test.mode().themePreference, 'dark');
  assert.equal(test.writes(), 0, 'Initial visit does not overwrite user storage');
  assert.ok(test.labels.every(label => label.hidden));
  test.connect();
  assert.ok(test.labels.every(label => !label.hidden));
  assert.ok(test.controls.every(control => control.value === 'dark'));
  test.system(!dark);
  assert.equal(test.mode().theme, 'dark', 'First-visit Night does not follow OS changes');
}
for (const dark of [false, true]) {
  const test = setup({ dark, stored: 'system' });
  assert.equal(test.mode().theme, dark ? 'dark' : 'light', 'Saved System resolves OS before DOM ready');
  assert.equal(test.mode().themePreference, 'system', 'Existing System preference is preserved');
  assert.equal(test.writes(), 0);
  test.connect();
  assert.ok(test.controls.every(control => control.value === 'system'));
  test.system(!dark);
  assert.equal(test.mode().theme, dark ? 'light' : 'dark');
}
for (const stored of ['light', 'dark']) {
  const test = setup({ stored, dark: stored === 'light', ready: 'complete' });
  assert.equal(test.mode().theme, stored, 'Explicit preference beats OS');
  test.system(stored === 'dark');
  assert.equal(test.mode().theme, stored, 'OS change does not override explicit preference');
}
const change = setup(); change.connect();
change.choose('dark');
assert.equal(change.mode().theme, 'dark');
assert.equal(change.store.get('pvme-theme'), 'dark');
assert.ok(change.controls.every(control => control.value === 'dark'));
change.choose('system'); change.system(true);
assert.equal(change.mode().theme, 'dark');
assert.equal(change.mode().themePreference, 'system');
change.store.set('pvme-theme', 'light'); change.window.fire('storage', { key: 'pvme-theme' });
assert.equal(change.mode().theme, 'light', 'Cross-tab preference sync');
change.store.delete('pvme-theme'); change.window.fire('storage', { key: null });
assert.equal(change.mode().themePreference, 'dark', 'Clearing storage restores the release Night default');
change.store.set('pvme-theme', 'light'); change.window.fire('storage', { key: 'unrelated' });
assert.equal(change.mode().themePreference, 'dark', 'Other preferences are ignored');
change.window.fire('pageshow');
assert.equal(change.mode().themePreference, 'light', 'Back-forward cache reconciles preference');
for (const stored of ['auto', 'night', 'null', '']) {
  assert.equal(setup({ stored, dark: false }).mode().theme, 'dark', 'Invalid saved values use Night');
}
const unavailable = setup({ blocked: true, dark: false }); unavailable.connect();
assert.equal(unavailable.mode().theme, 'dark', 'Blocked storage opens in Night, even on a light OS');
assert.equal(unavailable.mode().themePreference, 'dark');
unavailable.choose('light');
assert.equal(unavailable.mode().theme, 'light', 'Storage refusal never blocks choosing a mode');
unavailable.window.fire('pageshow');
assert.equal(unavailable.mode().theme, 'light', 'A blocked-storage session keeps its choice after bfcache restore');
unavailable.choose('system'); unavailable.system(true);
assert.equal(unavailable.mode().theme, 'dark', 'System remains available with blocked storage');
unavailable.system(false); unavailable.window.fire('pageshow');
assert.equal(unavailable.mode().theme, 'light');
assert.equal(unavailable.mode().themePreference, 'system', 'Blocked-storage BFCache restoration keeps the chosen System option');

const pairs = declarations => Object.fromEntries([...declarations.matchAll(/--([\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi)].map(([, name, day, night]) => [name, [day, night]]));
const values = pairs(css);
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
for (const index of [0, 1]) {
  for (const text of ['ink', 'text', 'muted']) for (const background of ['paper', 'white', 'sidebar', 'soft-fill']) {
    assert.ok(contrast(values[text][index], values[background][index]) >= 4.5, `${text}/${background}, ${index ? 'night' : 'day'}: normal text contrast`);
  }
  assert.ok(contrast(values.focus[index], values.paper[index]) >= 3, 'Focus indicator contrast');
}
let paletteCount = 0;
for (const [, declarations] of themes.matchAll(/\{([^{}]*--theme-accent:[^{}]*)\}/g)) {
  const palette = pairs(declarations); paletteCount++;
  for (const index of [0, 1]) for (const background of ['theme-pale', 'theme-wash']) {
    assert.ok(contrast(palette['theme-accent'][index], palette[background][index]) >= 4.5, `Palette ${paletteCount} accent/${background} in ${index ? 'night' : 'day'}`);
  }
}
assert.equal(paletteCount, 21, 'All section, boss, and combat-style palettes have night colours');
assert.match(css, /:root\s*\{\s*color-scheme:\s*dark;/, 'No-JS also opens in Night');
assert.match(css, /@media print\s*\{\s*:root,:root\[data-theme\]\s*\{ color-scheme:light/, 'Printed pages use light colours');
assert.doesNotMatch(source, /innerHTML|fetch\(|eval\(|setTimeout/, 'Theme code has no dynamic markup, network requests or delayed first paint');
const home = read('dist/index.html');
assert.match(home, /<script src="\/assets\/night-mode.js"><\/script>/, 'Classic non-deferred bootstrap');
assert.ok(home.indexOf('/assets/night-mode.js') < home.indexOf('rel="stylesheet"'), 'Theme applied before all styles');
assert.match(home, /<label class="theme-control" hidden>[\s\S]*?<select data-theme-control aria-label="Color theme">/, 'Native named theme selector, hidden without JS');
assert.doesNotMatch(home, /0[123] \/ PATH|class="path-level"|guides · one hub|READ HERE/, 'Redundant badges and repeated promotional labels removed');
for (const asset of ['night-mode.js', 'night-mode.css']) assert.equal(read(`dist/assets/${asset}`), read(`src/${asset}`));
console.log(`PASS night mode: first-visit/blocked-storage Night default, saved System/Day preservation, pre-paint selection, system/persistence/cross-tab lifecycle, 21 day/night palettes and authored text contrast.`);
