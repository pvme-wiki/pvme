#!/usr/bin/env node
/**
 * Replay the recovered reader shell/copy pass without parsing or reserializing HTML.
 * This is the Node-only equivalent of patch-reader-html.py. Source/inline articles
 * stay untouched. Import patchHtml, or run with distinct input/output directories.
 * The CLI writes HTML only; final asset and editor integration belongs to the build.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const THEME_HEAD = '<meta name="color-scheme" content="light dark"><script src="/assets/night-mode.js"></script>';
const THEME_CONTROL = '<label class="theme-control" hidden><span class="sr-only">Color theme</span><select data-theme-control aria-label="Color theme"><option value="system">System</option><option value="light">Day</option><option value="dark">Night</option></select></label>';

// Slice original strings rather than reserialize markup, including nested articles.
export function guideSpans(html) {
  const stack = [];
  const spans = [];
  let protectedStart = null;
  for (const match of html.matchAll(/<\/?article\b[^>]*>/gi)) {
    if (!match[0].toLowerCase().startsWith('</')) {
      stack.push(match.index);
      if (protectedStart === null && /\bclass="[^"]*\b(?:source-content|inline-guide-content)\b[^"]*"/.test(match[0])) {
        protectedStart = match.index;
      }
    } else {
      assert(stack.length, 'Unbalanced article close tag');
      const start = stack.pop();
      if (protectedStart === start) {
        spans.push([start, match.index + match[0].length]);
        protectedStart = null;
      }
    }
  }
  assert(protectedStart === null, 'Unclosed source article');
  return spans;
}

const COPY = [
  ['Set up. Learn. First kill.', 'Setup and first kills'],
  ['Upgrade. Improve. Explore.', 'Gear and damage'],
  ['Refine. Push. Master.', 'Rotations and achievements'],
  ['YOUR NEXT CHAPTER', 'LEARNING PATHS'],
  ['12 CURATED ENCOUNTERS', 'ENCOUNTER GUIDES'],
  ['CHOOSE YOUR INTENT', 'BOSS GUIDES'],
  ['How do you want to play?', 'Guides by approach'],
  ['THE WIKI COMPANION', 'RUNESCAPE WIKI'],
  ['Wiki-ready, by design.', 'MediaWiki draft'],
  ['EVERY GUIDE, ONE INDEX', 'BROWSE BY TOPIC'],
  ['YOUR FIRST PAGE, NOT YOUR LAST', 'GETTING STARTED'],
  ['Meet your next teacher.', 'Choose your first boss.'],
  ['MAKE THE NEXT UPGRADE COUNT', 'GEAR &amp; UPGRADES'],
  ['Choose a style. Open a guide. Plan your next upgrade.', 'Starting setups, upgrade orders, and damage guides for each combat style.'],
  ['Read in the order you need.', 'Setup, upgrades, and rotations'],
  ['Before you spend anything.', 'Free upgrades and perks'],
  ['YOUR PERSONAL SHORTLIST', 'SAVED BOSS HUBS'],
  ['Pick up where<br>you left off<span>.</span>', 'Saved guides<span>.</span>'],
  ['A good fight starts with a good plan.', 'No saved hubs yet.'],
  ['A PRODUCT EXPLORATION', 'ABOUT THIS EDITION'],
  ['A field guide.<br>Not another maze<span>.</span>', 'PvME Field Guide<span>.</span>'],
  ['The product idea', 'Guide organisation'],
  ['Knowledge organised around the fight.', 'Guide organisation'],
  ['<p>The visual language uses quiet surfaces, strong sans-serif type, precise labels, thin rules, and purposeful interaction.</p>', ''],
  ['Wiki-compatible is a path, not a theme.', 'Wiki compatibility'],
  ['A page off the map.', 'Page not found'],
];

function patchChrome(html) {
  if (!html.includes('/assets/night-mode.js')) {
    const old = '<meta name="referrer" content="no-referrer">';
    html = html.replace(old, () => old + THEME_HEAD);
  }
  if (!html.includes('/assets/night-mode.css')) {
    const old = '<link rel="stylesheet" href="/assets/themes.css">';
    html = html.replace(old, () => old + '<link rel="stylesheet" href="/assets/night-mode.css">');
  }
  if (!html.includes('data-theme-control')) {
    html = html.replace('<div class="top-links"><button', () => '<div class="top-links">' + THEME_CONTROL + '<button');
  }
  html = html.replaceAll('<span class="private-label"><i></i> Community edition</span>', '');
  html = html.replaceAll('<span class="edition">FIELD EDITION 003</span>', '');
  html = html.replace(/(<a href="\/about\/">About this edition <svg\b[^>]*>)<path d="M14 4h6v6m0-6L9 15M10 4H4v16h16v-6"\/>/g,
    '$1<path d="M5 12h14m-5-5 5 5-5 5"/>');
  html = html.replace(/<article class="boss-card"[^>]*>[\s\S]*?<\/article>/g, (original) => {
    let card = original;
    const focus = /<span class="art-caption">([^<]*)<\/span>/.exec(card);
    if (focus) {
      card = card.replace(/(<span class="catalog-number">)[^<]*(<\/span>)/, (_match, start, end) => start + focus[1] + end);
      card = card.replaceAll(focus[0], '');
    }
    return card.replaceAll('<span class="card-open">↗</span>', '<span class="card-open" aria-hidden="true">→</span>')
      .replaceAll(' guides · one hub', ' guides');
  });
  html = html.replace(/<span class="folder-tab">0[123] \/ PATH<\/span>/g, '');
  html = html.replace(/<span class="path-level" aria-hidden="true">(?:<i class="(?:lit)?"><\/i>){3}<\/span>/g, '');
  html = html.replace(/(<a class="guide-row"[^>]*>[\s\S]*?)<span>(?:Learn the fight|Advanced guides|Lower effort|Achievements)<\/span>([\s\S]*?<\/a>)/g, '$1$2');
  html = html.replace(/(<a class="library-row"[^>]*>[\s\S]*?)<small>READ HERE<\/small>([\s\S]*?<\/a>)/g, '$1$2');
  html = html.replace(/(\d+) guides\. Read every one here\./g, '$1 PvME guides, grouped by topic.');
  html = html.replace(/YOUR (NECROMANCY|MAGIC|MELEE|RANGED) TOOLKIT/g, '$1 GUIDES');
  for (const [before, after] of COPY) html = html.replaceAll(before, () => after);
  return html;
}

export function patchHtml(html) {
  const spans = guideSpans(html);
  const parts = [];
  let cursor = 0;
  for (const [start, end] of spans) {
    parts.push(patchChrome(html.slice(cursor, start)), html.slice(start, end));
    cursor = end;
  }
  parts.push(patchChrome(html.slice(cursor)));
  const result = parts.join('');
  assert.deepEqual(guideSpans(result).map(([start, end]) => result.slice(start, end)),
    spans.map(([start, end]) => html.slice(start, end)), 'Imported guide bodies changed');
  assert.equal(result.split('<script src="/assets/night-mode.js"></script>').length - 1, 1, 'Expected one theme bootstrap');
  assert.equal(result.split('href="/assets/night-mode.css"').length - 1, 1, 'Expected one theme stylesheet');
  assert.equal(result.split('data-theme-control').length - 1, 1, 'Expected one accessible theme control');
  assert(result.includes('rel="stylesheet"') && result.indexOf('/assets/night-mode.js') < result.indexOf('rel="stylesheet"'), 'Bootstrap must precede styles');
  return result;
}

async function htmlFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(path);
  }
  return files.sort();
}

async function main(args) {
  assert.equal(args.length, 2, 'Usage: node patch-reader-html.mjs INPUT_DIR OUTPUT_DIR');
  const [input, output] = args.map((path) => resolve(path));
  assert.notEqual(input, output, 'Use a distinct output directory; parent owns final integration');
  const physicalInput = await realpath(input);
  await mkdir(output, { recursive: true });
  assert.notEqual(physicalInput, await realpath(output), 'Use a distinct output directory; parent owns final integration');
  const files = await htmlFiles(input);
  assert(files.length, 'No reader HTML files found');
  let changed = 0;
  let bodies = 0;
  for (const source of files) {
    const original = await readFile(source, 'utf8');
    const updated = patchHtml(original);
    changed += Number(updated !== original);
    bodies += guideSpans(original).length;
    const target = join(output, relative(input, source));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, updated, 'utf8');
  }
  console.log(`Patched ${changed} of ${files.length} HTML files; ${bodies} imported article bodies preserved byte-for-byte.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
