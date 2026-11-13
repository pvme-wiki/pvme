import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { readSnapshot } from './reader-snapshot.mjs';
import { polishReader } from './boss-hub.mjs';
import { escapeHtml } from '../editor/shared/model.mjs';
import { createSearchIndex, guideDocument, bossDocument, canonicalGuideCategory, groupSearchResults } from '../src/search-engine.mjs';

const root = path.resolve(import.meta.dirname, '..');
const original = readSnapshot(root), files = new Map(original);
const bosses = polishReader(files, root), catalog = JSON.parse(files.get('data/catalog.json'));
const index = createSearchIndex([...bosses.map(bossDocument), ...catalog.map(guideDocument)]);
const hrefs = html => [...html.matchAll(/class="guide-row"[^>]*href="([^"]+)"/g)].map(match => match[1]);

test('Ghrazi overview and 100% method are one searchable boss group', () => {
  const boss = bosses.find(item => item.id === 'ghrazi-blood-knights');
  const expected = boss.guides.map(guide => guide.id).sort();
  assert.equal(expected.length, 2);
  assert.deepEqual(boss.guides.map(guide => guide.guideType).sort(), ['methods', 'overview']);
  for (const query of ['ghrazi', 'ghrazi blood knights', 'gbk', 'ghrazi blood knigts']) {
    const grouped = groupSearchResults(index.search(query), bosses).find(group => group.boss?.id === boss.id);
    assert.deepEqual(grouped.results.map(result => result.record.guide.id).sort(), expected, query);
  }
  const library = files.get('guides/index.html').toString();
  const group = library.match(/<section class="library-group library-boss-group" data-category="Boss guides" data-boss="ghrazi-blood-knights">[\s\S]*?<\/section>/)?.[0];
  for (const guide of boss.guides) assert.ok(group.includes(`href="${guide.local}"`));
  assert.match(group, /Fight overview/);
  assert.match(group, /100% · Ranged &amp; melee/);
});

test('all boss hubs include every attached guide exactly once and keep every original guide URL', () => {
  const originals = JSON.parse(original.get('data/catalog.json'));
  assert.deepEqual(catalog.map(guide => [guide.id, guide.local, guide.url]), originals.map(guide => [guide.id, guide.local, guide.url]));
  const library = files.get('guides/index.html').toString();
  for (const boss of bosses) {
    const page = files.get(boss.url.slice(1) + 'index.html').toString();
    assert.deepEqual(hrefs(page).sort(), boss.guides.map(guide => guide.local).sort(), boss.id);
    for (const guide of boss.guides) {
      assert.equal(guide.category, 'Boss guides');
      assert.equal(guide.boss, boss.id);
      assert.equal(guide.bossUrl, boss.url);
      assert.ok(library.includes(`href="${guide.local}"`));
      const reader = files.get(guide.local.slice(1) + 'index.html').toString();
      assert.ok(reader.includes(`aria-label="${escapeHtml(boss.name)} guides"`), guide.id);
      assert.ok(reader.includes(`href="${boss.url}"`), guide.id);
      assert.equal((reader.match(/aria-current="page"/g) || []).length >= 1, true, guide.id);
      assert.deepEqual(hrefs(reader).sort(), boss.guides.map(guide => guide.local).sort(), guide.id);
    }
  }
  for (const id of ['kerapac', 'raksha', 'arch-glacor', 'rasial']) {
    const boss = bosses.find(item => item.id === id);
    const found = new Set(index.search(boss.name).filter(result => result.record.kind === 'guide').map(result => result.record.guide.id));
    for (const guide of boss.guides) assert.ok(found.has(guide.id), guide.id);
  }
});

test('old boss-topic URLs restore to the combined topic and show both Ghrazi guides', async () => {
  const built = files.get('assets/app.js').toString();
  const restore = built.slice(built.indexOf('function restoreLibrary()'), built.indexOf("$('#library-search')?.addEventListener"));
  for (const category of ['Advanced boss guides', 'Boss methods', 'Boss fundamentals']) {
    const input = {value: 'stale'}, select = {value: '', options: [{value: 'all'}, {value: 'Boss guides'}]};
    const context = vm.createContext({
      $: selector => selector === '#library-search' ? input : select,
      URLSearchParams, location: {search: '?q=ghrazi&category=' + encodeURIComponent(category)}, canonicalGuideCategory,
      validValue: (value, values) => values.includes(value) ? value : 'all', filterLibrary() {},
    });
    vm.runInContext(restore + 'restoreLibrary()', context);
    assert.equal(input.value, 'ghrazi');
    assert.equal(select.value, 'Boss guides');
    const results = index.search(input.value, {filter: record => record.kind === 'guide' && record.category === select.value});
    assert.equal(results.filter(result => result.record.guide.boss === 'ghrazi-blood-knights').length, 2);
  }
  assert.equal(canonicalGuideCategory('Combat achievements'), 'Combat achievements');
});

test('boss parent and sibling navigation also appear on readable aliases without changing favorite IDs', () => {
  const slots = JSON.parse(fs.readFileSync(path.join(root, 'reader/reader-slots.json'))).pages;
  const bySource = new Map(catalog.map(guide => [new URL(guide.url).pathname, guide]));
  let checked = 0;
  for (const slot of slots) {
    if (slots.filter(other => other.pagePath === slot.pagePath).length !== 1) continue;
    const guide = bySource.get(slot.sourcePath);
    if (!guide?.boss) continue;
    const html = files.get(slot.pagePath).toString();
    assert.ok(html.includes(`data-save="guide:${guide.id}"`), slot.pagePath);
    assert.ok(html.includes(`href="${guide.bossUrl}"`), slot.pagePath);
    assert.ok(html.includes('class="boss-method-navigation"'), slot.pagePath);
    checked++;
  }
  assert.ok(checked > 200);
});

test('grouped search Enter keeps the best matching destination while arrows can visit the boss heading', async () => {
  const source = fs.readFileSync(path.join(root, 'src/global-search.js'), 'utf8');
  const rendering = source.slice(0, source.indexOf('let searchTrigger;'));
  const keyboard = source.slice(source.indexOf('dialog?.addEventListener("keydown"'), source.indexOf('document.addEventListener("keydown"'));
  for (const query of ['ghrazi', 'Raksha necromancy', 'ghrazi 100']) {
    const clicked = [], handlers = {}, input = {value: query};
    const document = {activeElement: input, createElement: tag => element(tag)};
    function element(tag) {
      return {
        tag, children: [], attributes: {}, append(...children) {this.children.push(...children)},
        replaceChildren(...children) {this.children = children},
        setAttribute(name, value) {this.attributes[name] = value}, removeAttribute(name) {delete this.attributes[name]},
        getAttribute(name) {return name === 'href' ? this.href : this.attributes[name]},
        querySelectorAll(selector) {return this.children.flatMap(child => [...(selector === 'a' && child.tag === 'a' ? [child] : []), ...child.querySelectorAll(selector)])},
        click() {clicked.push(this.href)}, focus() {document.activeElement = this},
      };
    }
    const results = element('div'), status = {}, dialog = {open: true, addEventListener(name, handler) {handlers[name] = handler}};
    const context = vm.createContext({
      document, $: selector => ({'#search-dialog': dialog, '#global-search': input, '#search-results': results, '#search-status': status})[selector],
      loadSearch: async () => ({index, bosses}), normalizeQuery: value => value.toLowerCase().trim(), groupSearchResults,
      guideSearchSummary: guide => guide?.guideType || '', bossSearchSummary: boss => `${boss.guides.length} guides`,
    });
    vm.runInContext(rendering + keyboard, context);
    await vm.runInContext('renderSearch()', context);
    const links = results.querySelectorAll('a');
    assert.ok(links[0].href.startsWith('/bosses/'), query);
    handlers.keydown({key: 'ArrowDown', preventDefault() {}});
    assert.equal(document.activeElement, links[0]);
    document.activeElement = input;
    handlers.keydown({key: 'Enter', preventDefault() {}});
    assert.deepEqual(clicked, [index.search(query)[0].record.href], query);
    if (query !== 'ghrazi') assert.ok(clicked[0].startsWith('/archive/'), query);
  }
});
