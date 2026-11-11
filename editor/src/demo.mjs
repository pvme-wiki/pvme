import { themeOptions } from './theme.mjs';
import { DeviceAdapter, ServiceAdapter } from './adapter.mjs';
import { renderDocument, renderBlock, textContent, getEditableTextNodes, updateTextNode, assertDocument } from '../shared/model.mjs';
import { escapeHTML as e, sectionsOf, changedBlocks, conflictPlan, resolveConflict, timeLabel } from './document.mjs';
import { exportBundle, download } from './export.mjs';
import { icon, rune, art } from './icons.mjs';

const readerOptions = { readerBaseUrl: 'https://pvme-preview.vercel.app' };
const app = document.querySelector('#app'), dialog = document.querySelector('#dialog');
const visuals = { 'arch-glacor-basic':['frost','ice','Arch-Glacor'], 'interface-guide':['interface','sage','Interface guide'], 'dpm-advice-mage':['magic','violet','DPM advice: Magic'], 'necromancy-upgrade-order':['necro','gold','Necromancy upgrades'], 'low-effort-rasial':['rasial','rose','Low-effort Rasial'] };
const state = { catalog: [], drafts: new Map(), seeds: new Map(), guide: null, document: null, savedDocument: null, revision: 0, savedAt: null, dirty: false, saving: false, error: null, conflict: null, remote: false, view: 'library', section: null, filter: 'all', query: '', editVersion: 0, reviews: [], activeReview: null };
let adapter, saveTimer, savePromise, routeVersion = 0, activeHash = '', toastTimer, reviewSummary = '';
let tabId;
try { tabId = sessionStorage.getItem('pvme-tab') || crypto.randomUUID(); sessionStorage.setItem('pvme-tab', tabId); } catch { tabId = crypto.randomUUID(); }
const recoveryKey = id => `pvme-recovery-${tabId}-${id}`;
const nameOf = id => visuals[id]?.[2] || state.catalog.find(item => item.id === id)?.title || id;
const href = path => `#/${path}`;
const guidePath = view => href(`guide/${state.guide.id}/${view}`);
const changes = () => state.guide && state.document ? changedBlocks(state.seeds.get(state.guide.id), state.document) : [];
const isLocal = () => adapter?.mode === 'local-service';
const announce = message => { document.querySelector('#announcer').textContent = message; };
function toast(message) { const el = document.querySelector('#toast'); clearTimeout(toastTimer); el.textContent = message; el.hidden = false; toastTimer = setTimeout(() => { el.hidden = true; }, 5500); announce(message); }
const button = (action, label, kind = '', extra = '') => `<button type="button" class="button ${kind}" data-action="${action}" ${extra}>${label}</button>`;

async function loadSeed(id) {
  if (state.seeds.has(id)) return structuredClone(state.seeds.get(id));
  const guide = state.catalog.find(item => item.id === id);
  if (!guide) throw new Error('That guide is not in this prototype.');
  const response = await fetch(new URL(`../content/${guide.file}`, import.meta.url));
  if (!response.ok) throw new Error('The guide could not load. Please try again.');
  const document = await response.json(); state.seeds.set(id, document); return structuredClone(document);
}
// A per-tab session backup survives reloads without one tab clearing another tab’s unsaved copy.
function saveRecovery() {
  if (!state.guide || !state.document) return;
  try { sessionStorage.setItem(recoveryKey(state.guide.id), JSON.stringify({ document: state.document, base: state.savedDocument, revision: state.revision, at: Date.now() })); } catch { /* Autosave reports durable storage failures; the in-memory copy stays intact. */ }
}
function clearRecovery(id) { try { sessionStorage.removeItem(recoveryKey(id)); } catch {} }
function recoveryFor(id) { try { return JSON.parse(sessionStorage.getItem(recoveryKey(id))); } catch { return null; } }

function modeBanner() {
  return isLocal()
    ? `<div class="mode-banner local">${icon('branch')}<span><strong>Local sandbox.</strong> Drafts and Git stay on this computer. No GitHub or live publishing.</span><button data-action="how" aria-label="About this local prototype">${icon('info')}</button></div>`
    : `<div class="mode-banner">${icon('device')}<span><strong>Device-only demo.</strong> Drafts stay in this browser. No cloud sync, GitHub or live publishing.</span><button data-action="how" aria-label="About this device-only demo">${icon('info')}</button></div>`;
}
function shell(content, { active = 'guides', wide = false } = {}) {
  return `<header class="topbar"><a class="brand" href="#/" aria-label="PvME workbench home">${rune}<span>PvME<small>THE WORKBENCH</small></span></a>${themeOptions()}<a class="mobile-queue text-button" href="#/reviews">${icon('review')}Reviews</a><button class="text-button top-help" data-action="how" aria-label="How it works">${icon('help')}<span>How it works</span></button></header>
  <div class="app-layout"><aside class="sidebar"><div class="rail-label">YOUR WORKSPACE</div><nav aria-label="Workspace"><a href="#/" class="rail-link ${active==='guides'?'active':''}" ${active==='guides'?'aria-current="page"':''}>${icon('book')}Guide library<span>05</span></a><a href="#/reviews" class="rail-link ${active==='reviews'?'active':''}" ${active==='reviews'?'aria-current="page"':''}>${icon('review')}Review queue<span id="review-count">${state.reviews.filter(item=>item.status==='pending').length || '—'}</span></a></nav><div class="rail-note"><span class="mini-rune">✧</span><h3>Small edits.<br>Stronger guides.</h3><p>Made for the people<br>behind the knowledge.</p></div><div class="rail-foot">${icon('lock')}<span>${isLocal()?'LOCAL SANDBOX':'YOUR BROWSER ONLY'}<small>Prototype · No live publishing</small></span></div></aside>
  <div class="workspace ${wide?'wide':''}">${modeBanner()}<main id="main" tabindex="-1">${content}</main><footer class="footer"><span>PvME · A community field guide</span><a href="https://pvme.io/" target="_blank" rel="noopener noreferrer">Original encyclopedia ${icon('arrow')}</a></footer></div></div>`;
}
function howItWorks() {
  showDialog(`<div class="dialog-heading"><span class="eyebrow">A SAFE PLACE TO TRY</span><h2>A workbench, not the live site.</h2></div><p>${isLocal()?'This local sandbox saves to this computer and can create real commits in a separate sandbox repository. It never pushes to GitHub.':'This prototype saves drafts in this browser, on this device. Clearing site data removes them. It does not sign you in, sync between devices, send to a reviewer, or change the live PvME site.'}</p><ol class="how-steps"><li><strong>Make a small edit</strong><span>Change guide text. Original icons, links and rich blocks stay intact.</span></li><li><strong>Read the difference</strong><span>Preview the whole guide, compare changes, then make a review snapshot.</span></li><li><strong>${isLocal()?'Publish to the sandbox':'Try a demo publication'}</strong><span>${isLocal()?'An approved snapshot becomes a local Git commit and a reading page.':'A frozen reading preview is stored in this browser only. You are playing both editor and reviewer.'}</span></li></ol><p class="dialog-note">Nothing goes to GitHub or the live site. Export a ZIP to keep the structured source, a reading preview and a review note. No account or credentials needed.</p>${button('close-dialog','Back to the workbench','primary full')}`);
}
function showDialog(html, className = '') { dialog.className = className; dialog.innerHTML = `<button class="dialog-close icon-button" data-action="close-dialog" aria-label="Close dialog">${icon('close')}</button>${html}`; if (!dialog.open) dialog.showModal(); }
function library() {
  const filtered = state.catalog.filter(guide => (state.filter==='all' || guide.category===state.filter) && `${guide.title} ${guide.summary} ${nameOf(guide.id)}`.toLowerCase().includes(state.query.toLowerCase()));
  app.innerHTML = shell(`<section class="library-hero"><div><div class="eyebrow"><span class="green-dot"></span> THE EDITING WORKBENCH</div><h1>Good guides.<br><em>Built together.</em></h1><p>A clearer sentence. A better tip. A little knowledge<br class="desktop-only"> that makes someone’s next kill easier.</p></div><div class="hero-note"><span class="note-mark">✧</span><span class="eyebrow">A SHARED CRAFT</span><p>Leave the guide a little<br>better than you found it.</p><span class="note-line"></span></div></section>
  <div class="workflow-strip" aria-label="Editing workflow"><span><i>01</i>Edit a section</span>${icon('arrow')}<span><i>02</i>Review changes</span>${icon('arrow')}<span><i>03</i>${isLocal()?'Local publish':'Demo publish'}</span></div>
  <section aria-labelledby="library-title"><div class="section-heading"><div><span class="eyebrow">A GOOD PLACE TO START</span><h2 id="library-title">The guide shelf <span>05</span></h2></div><label class="search-box">${icon('search')}<input type="search" id="guide-search" placeholder="Find a guide" aria-label="Find a guide" value="${e(state.query)}"></label></div>
  <div class="filter-row" role="group" aria-label="Filter guides">${['all', ...new Set(state.catalog.map(item=>item.category))].map(filter=>`<button class="filter ${state.filter===filter?'selected':''}" data-filter="${e(filter)}" aria-pressed="${state.filter===filter}">${filter==='all'?'All guides':e(filter)}</button>`).join('')}</div>
  <div class="guide-grid">${filtered.map((guide,index)=>{ const [type,tone,title] = visuals[guide.id], draft = state.drafts.get(guide.id); return `<a href="${href(`guide/${guide.id}/edit`)}" class="guide-card ${tone} ${guide.id==='arch-glacor-basic'?'featured':''}"><div class="card-art">${art(type)}<span class="art-coordinates">${String(state.catalog.indexOf(guide)+1).padStart(2,'0')} / FIELD GUIDE</span></div><div class="card-copy"><div class="card-overline"><span class="category">${e(guide.category)}</span>${draft?.revision>0?'<span class="draft-badge">Draft saved</span>':''}</div><h3>${e(title)}</h3><p>${e(guide.summary)}</p><div class="card-bottom"><span>${draft?.revision>0?`Edited ${timeLabel(draft.savedAt).toLowerCase()}`:`${guide.stats.editableBlocks} editable blocks`}</span><span class="card-action">${draft?.revision>0?'Continue editing':'Open guide'} ${icon('arrow')}</span></div></div></a>`; }).join('')}</div>
  ${filtered.length?'':'<div class="empty-state"><h3>No guides found</h3><p>Try “Magic”, “Rasial” or a different filter.</p></div>'}<div class="shelf-note">${icon('lock')}<p>Five complete guides, not shortened examples. Original media and complex blocks are preserved.</p></div></section>`);
}
function statusMarkup() {
  if (state.conflict) return `${icon('warning')}<span>Newer draft found</span>`;
  if (state.error) return `${icon('warning')}<span>Not saved</span>`;
  if (state.saving) return `<span class="status-spinner"></span><span>Saving…</span>`;
  if (state.dirty) return `<span class="status-dot pending"></span><span>Unsaved changes</span>`;
  return `${icon('check')}<span>${state.savedAt?(isLocal()?'Saved locally':'Saved in this browser'):'Ready to edit'}</span>`;
}
function updateStatus() {
  const el = document.querySelector('#save-status'); if (el) { el.innerHTML = statusMarkup(); el.className = `save-status ${state.error||state.conflict?'error':''}`; }
  document.querySelectorAll('[data-change-count]').forEach(el=>{ el.textContent = changes().length; });
  const region = document.querySelector('#save-alert');
  if (region) region.innerHTML = alertMarkup();
}
function alertMarkup() {
  if (state.conflict) return `<div class="save-alert conflict">${icon('warning')}<div><strong>A newer version was saved.</strong><p>Your edit is safe on screen. Compare both versions before saving.</p></div>${button('resolve','Compare versions','small')}</div>`;
  if (state.error) return `<div class="save-alert">${icon('warning')}<div><strong>Your changes have not saved.</strong><p>${e(state.error)}</p></div><div class="alert-actions">${button('retry','Try again','small')}${button('download-draft','Download my draft','small')}</div></div>`;
  if (state.remote) return `<div class="save-alert remote">${icon('history')}<div><strong>Another tab has a newer draft.</strong><p>${state.dirty?'Save to compare it with your edits.':'Load it before you keep editing.'}</p></div>${button('load-remote','Load newer draft','small')}</div>`;
  return '';
}
function guideHeader(view) {
  const [type,tone] = visuals[state.guide.id];
  return `<a class="back-link" href="#/">${icon('back')}Guide library</a><div class="guide-heading"><div><div class="eyebrow">${e(state.guide.category)} <span class="slash">/</span> COMPLETE GUIDE</div><h1>${e(nameOf(state.guide.id))}</h1><div class="guide-meta"><span class="save-status" id="save-status" role="status" aria-live="polite">${statusMarkup()}</span><span class="revision">Revision ${state.revision}</span></div></div><div class="heading-art ${tone}">${art(type)}</div></div><div id="save-alert">${alertMarkup()}</div><nav class="guide-tabs" aria-label="Guide workflow">${[['edit','pen','Edit'],['preview','eye','Preview'],['review','review','Review']].map(([id,ico,label])=>`<a href="${guidePath(id)}" class="${id===view?'active':''}" ${id===view?'aria-current="page"':''}>${icon(ico)}${label}${id==='review'?`<span class="tab-count" data-change-count>${changes().length}</span>`:''}</a>`).join('')}<button class="text-button export-top" data-action="export">${icon('download')}Export</button></nav>`;
}
function visibleBlock(block) {
  return textContent(block).replace(/[\s\u200b\u200e]/g,'') || /img|video|iframe|table/.test(JSON.stringify(block.node));
}
function renderEditor() {
  const sections = sectionsOf(state.document); let selected = sections.find(section=>section.id===state.section);
  if (!selected) selected = sections.find(section=>section.blocks.some(block=>block.editable)) || sections[0];
  state.section = selected.id; const index = sections.indexOf(selected);
  app.innerHTML = shell(`${guideHeader('edit')}<div class="editor-layout"><aside class="section-sidebar"><div class="section-sidebar-title"><span class="eyebrow">IN THIS GUIDE</span><span>${String(sections.length).padStart(2,'0')}</span></div><nav aria-label="Guide sections">${sections.map((section,i)=>`<button class="section-link ${section.id===selected.id?'selected':''}" data-section="${e(section.id)}" ${section.id===selected.id?'aria-current="true"':''}><span>${String(i+1).padStart(2,'0')}</span><strong>${e(section.title)}</strong>${section.blocks.some(block=>changes().some(change=>change.id===block.id))?'<i class="edited-dot" aria-label="Edited"></i>':''}</button>`).join('')}</nav><p class="section-hint">One section at a time.<br>Every change saves as you go.</p></aside><section class="editing-panel" aria-label="Edit guide section"><div class="mobile-section"><label for="section-select">SECTION ${index+1} OF ${sections.length}</label><select id="section-select">${sections.map((section,i)=>`<option value="${e(section.id)}" ${section.id===selected.id?'selected':''}>${i+1}. ${e(section.title)}</option>`).join('')}</select></div><div class="editor-section-top"><div><span class="eyebrow">SECTION ${String(index+1).padStart(2,'0')} <span class="slash">/</span> ${String(sections.length).padStart(2,'0')}</span><h2>${e(selected.title)}</h2></div><span class="editing-label">${icon('pen')}Editing</span></div><div class="editing-tip">${icon('info')}<p>Tap the text to edit. Icons, links and formatting stay intact.</p></div><div class="editable-blocks">${selected.blocks.filter(visibleBlock).map((block,i)=>blockHTML(block,i)).join('')}</div><div class="section-pagination"><button class="text-button" data-action="previous-section" ${index===0?'disabled':''}>${icon('back')}Previous</button><span>${index+1} / ${sections.length}</span><button class="text-button" data-action="next-section" ${index===sections.length-1?'disabled':''}>Next section${icon('arrow')}</button></div></section></div><div class="editor-bottom"><div class="bottom-save">${icon('check')}<span>Your knowledge, safely drafted.<small>${isLocal()?'Local sandbox only':'Only in this browser'}</small></span></div><a class="button quiet" href="${guidePath('preview')}">${icon('eye')}Preview</a><a class="button primary" href="${guidePath('review')}">Review <span data-change-count>${changes().length}</span>${icon('arrow')}</a></div>`, { wide:true });
  document.querySelectorAll('.edit-block [data-node-id]').forEach((span,i)=>{
    span.contentEditable = 'plaintext-only'; span.setAttribute('role','textbox'); span.setAttribute('aria-multiline','true'); span.setAttribute('aria-label',`${span.closest('.edit-block').dataset.label}, text ${i+1}`); span.setAttribute('spellcheck','true');
  });
  // Links remain readable but cannot navigate while their text is being edited.
  document.querySelectorAll('.edit-block a').forEach(link=>{ link.tabIndex=-1; });
}
function blockHTML(block, index) {
  const edited = changes().some(change=>change.id===block.id);
  if (!block.editable) return `<details class="locked-block"><summary><span class="locked-symbol">${icon(block.type==='media'?'eye':'lock')}</span><span><strong>${block.type==='media'?'Original media':'Preserved source block'}</strong><small>Read-only · kept in every preview and export</small></span><span class="lock-expand">+</span></summary><div class="locked-content guide-content">${renderBlock(block,readerOptions)}</div><p class="locked-note">This richer block is protected in the prototype. Nothing inside it is removed or rewritten.</p></details>`;
  return `<div class="edit-block ${block.type==='heading'?'heading-block':''} ${edited?'changed':''}" data-block-id="${e(block.id)}" data-label="${e(block.type==='heading'?'Section heading':`Paragraph ${index+1}`)}"><div class="block-meta"><span>${block.type==='heading'?'HEADING':'TEXT'}</span><span class="block-state">${edited?'Edited':icon('pen')}</span></div><div class="guide-content editable-content">${renderBlock(block,{...readerOptions,textNodeAttributes:true})}</div></div>`;
}
function previewView() {
  app.innerHTML = shell(`${guideHeader('preview')}<div class="preview-heading"><div><span class="eyebrow">AS READERS WILL SEE IT</span><h2>The whole guide, in context.</h2></div><span class="pill">Draft preview</span></div><div class="preview-notice">${icon('eye')}<span>A preview of your current draft. This is not the live PvME site.</span></div><article class="reading-paper"><div class="reading-overline">PvME / FIELD GUIDE</div><h1>${e(nameOf(state.guide.id))}</h1><div class="guide-content reading-content">${renderDocument(state.document,readerOptions)}</div>${sourceFoot(state.document)}</article><div class="editor-bottom"><a href="${guidePath('edit')}" class="button quiet">${icon('back')}Keep editing</a><a href="${guidePath('review')}" class="button primary">Review changes${icon('arrow')}</a></div>`);
  fixPreviewAnchors();
}
function sourceFoot(document) { return `<div class="source-foot"><strong>Knowledge by ${e(document.source.attribution || 'PvME contributors')}</strong><span><a href="${e(document.source.url)}" target="_blank" rel="noopener noreferrer">Original guide</a> · <a href="${e(document.source.licenseUrl)}" target="_blank" rel="noopener noreferrer">${e(document.source.license)}</a></span></div>`; }
function changeList(document, baseline) {
  const list = changedBlocks(baseline,document);
  return list.map((change,index)=>`<section class="change-card"><div class="change-heading"><span class="change-number">${String(index+1).padStart(2,'0')}</span><h3>${e(change.label.replace(/[\u200b\u200e]/g,'').slice(0,85))}</h3><span class="pill green">Text edited</span></div><div class="diff-before"><span class="diff-label">BEFORE</span><p>${e(change.before)}</p></div><div class="diff-after"><span class="diff-label">AFTER</span><p>${e(change.after)}</p></div></section>`).join('');
}
function reviewView() {
  const list=changes();
  app.innerHTML = shell(`${guideHeader('review')}<div class="review-intro"><span class="eyebrow">A MOMENT TO DOUBLE-CHECK</span><h2>A little change.<br>A clearer guide.</h2><p>${list.length?`${list.length} ${list.length===1?'block':'blocks'} changed from the bundled guide. Check the wording, then add a short note.`:'No changes yet. Head back to Edit and sharpen a sentence.'}</p></div><div class="review-layout"><div>${list.length?changeList(state.document,state.seeds.get(state.guide.id)):`<div class="empty-state">${icon('pen')}<h3>Your first edit starts here.</h3><p>Try making a tip easier to understand.</p><a class="button primary" href="${guidePath('edit')}">Back to editing${icon('arrow')}</a></div>`}</div><aside class="review-summary"><span class="eyebrow">READY TO PASS IT ON?</span><h3>Leave a trail.</h3><label for="review-summary">What changed?</label><textarea id="review-summary" rows="4" maxlength="500" placeholder="e.g. Clarified the normal-mode mechanics">${e(reviewSummary)}</textarea><p>One sentence is enough. This note travels with the review and export.</p><div class="review-checks"><span>${icon('check')}Original icons and links preserved</span><span>${icon('check')}Full guide included</span><span>${icon('lock')}${isLocal()?'Sandbox only, no GitHub push':'Demo review, not sent to anyone'}</span></div>${button('submit-review',`${isLocal()?'Create review':'Create demo review'}${icon('arrow')}`,'primary full',list.length?'':'disabled')}<button class="text-button full" data-action="export">${icon('download')}Download Git-ready ZIP</button></aside></div><div class="editor-bottom"><a href="${guidePath('edit')}" class="button quiet">${icon('back')}Keep editing</a><a href="${guidePath('preview')}" class="button">${icon('eye')}Read the preview</a></div>`);
}
async function queueView(version = routeVersion) {
  const reviews = (await adapter.listReviews()).reviews;
  if (version !== routeVersion) return;
  state.reviews = reviews;
  app.innerHTML = shell(`<div class="queue-hero"><span class="eyebrow">THE NEXT PAIR OF EYES</span><h1>Review queue<span class="title-dot">.</span></h1><p>${isLocal()?'Review a frozen snapshot, then publish it to the local Git sandbox.':'You play both editor and reviewer here. These snapshots stay in this browser.'}</p></div><div class="queue-header"><h2>Saved for review <span>${String(state.reviews.length).padStart(2,'0')}</span></h2><a class="text-button" href="#/">Guide library${icon('arrow')}</a></div>${state.reviews.length?`<div class="review-list">${state.reviews.map(review=>`<a class="review-row" href="${href(`review/${review.id}`)}"><div class="review-row-icon ${visuals[review.guideId]?.[1]}">${icon(review.status==='published'?'check':'review')}</div><div class="review-row-copy"><span class="eyebrow">${review.status==='published'?(isLocal()?'LOCAL PUBLICATION':'DEMO PUBLISHED'):'AWAITING YOUR REVIEW'}</span><h3>${e(nameOf(review.guideId))}</h3><p>${e(review.summary)}</p><small>Revision ${review.baseRevision} · ${timeLabel(review.createdAt)}</small></div>${icon('arrow')}</a>`).join('')}</div>`:`<div class="empty-state large">${icon('review')}<h2>Good edits start small.</h2><p>Edit a guide and create a review.<br>Your snapshot will be waiting here.</p><a class="button primary" href="#/">Choose a guide${icon('arrow')}</a></div>`}`,{active:'reviews'});
}
async function reviewDetail(id, version = routeVersion) {
  const review = await adapter.getReview(id);
  const baseline=await loadSeed(review.guideId);
  if (version !== routeVersion) return;
  state.activeReview=review; const list=changedBlocks(baseline,review.document);
  app.innerHTML = shell(`<a class="back-link" href="#/reviews">${icon('back')}Review queue</a><div class="review-detail-heading"><span class="eyebrow">${review.status==='published'?'A PUBLISHED SNAPSHOT':'ONE LAST LOOK'}</span><h1>${e(nameOf(review.guideId))}</h1><p class="review-quote">${e(review.summary)}</p><div class="review-detail-meta"><span class="pill ${review.status==='published'?'green':'gold'}">${review.status==='published'?(isLocal()?'Published locally':'Demo published'):'Ready for review'}</span><span>Revision ${review.baseRevision} · ${timeLabel(review.createdAt)}</span></div></div><div class="review-layout"><div><div class="section-heading compact"><h2>${list.length} changed ${list.length===1?'block':'blocks'}</h2><span class="fine-print">Compared with the bundled guide</span></div>${changeList(review.document,baseline)}</div><aside class="review-summary"><span class="eyebrow">FROZEN & READY</span><h3>${review.status==='published'?'Snapshot published.':'Make the next step.'}</h3><p>This snapshot will not change if you keep editing the draft.</p><div class="publication-callout">${icon('globe')}<strong>${isLocal()?'Local Git + reading page':'A reading preview in this browser'}</strong><p>${isLocal()?'Publish creates a real local commit in an isolated sandbox. No GitHub push or live-site change.':'Demo publication saves a reading preview here. No Git commit is made, nobody is notified, and nothing goes live.'}</p></div>${review.status==='published'?`<a class="button primary full" href="${href(`published/${review.guideId}`)}">Open latest publication${icon('arrow')}</a>`:button('publish-review',`${isLocal()?'Publish to local sandbox':'Publish demo preview'}${icon('arrow')}`,'primary full')}<button class="text-button full" data-action="export-review">${icon('download')}Download Git-ready ZIP</button><a class="text-button full" href="${href(`guide/${review.guideId}/edit`)}">Back to the draft</a></aside></div>`,{active:'reviews'});
}
async function publishedView(id, version = routeVersion) {
  const publication=await adapter.getPublished(id);
  if (version !== routeVersion) return;
  state.publication=publication;
  app.innerHTML=shell(`<a class="back-link" href="#/reviews">${icon('back')}Review queue</a><div class="publication-success"><span class="success-seal">${icon('check')}</span><div><span class="eyebrow">${isLocal()?'LOCAL SANDBOX PUBLICATION':'DEMO PUBLICATION · THIS BROWSER ONLY'}</span><h2>A clearer guide, ready to read.</h2><p>${isLocal()?'Saved as a real local Git commit. Nothing has been pushed to GitHub or the live site.':'Your review became a reading preview in this browser. Nothing has been sent to GitHub or the live site.'}</p></div></div><div class="publication-bar"><span>Revision ${publication.revision} · ${timeLabel(publication.publishedAt)}${publication.commit?` · Commit ${e(String(publication.commit).slice(0,8))}`:''}</span><button class="text-button" data-action="export-published">${icon('download')}Export snapshot</button></div><article class="reading-paper"><div class="reading-overline">PvME / ${isLocal()?'LOCAL':'DEMO'} PUBLISHED SNAPSHOT</div><h1>${e(nameOf(id))}</h1><div class="guide-content reading-content">${renderDocument(publication.document,readerOptions)}</div>${sourceFoot(publication.document)}</article><div class="editor-bottom"><a class="button quiet" href="#/">${icon('back')}Guide library</a><a class="button primary" href="${href(`guide/${id}/edit`)}">Keep improving${icon('pen')}</a></div>`,{active:'reviews'});
  fixPreviewAnchors();
}
function fixPreviewAnchors() {
  document.querySelectorAll('.guide-content a').forEach(link=>{ const raw=link.getAttribute('href'); if(raw?.startsWith('#')) { link.dataset.fragment=raw.slice(1); } else { link.target='_blank'; link.rel='noopener noreferrer'; } });
}

async function openGuide(id, version = routeVersion) {
  if (state.guide?.id===id && state.document?.id===id) return;
  const guide = state.catalog.find(item=>item.id===id); if (!guide) throw new Error('Guide not found.');
  const seed=await loadSeed(id); let draft, errorMessage=null;
  if (version !== routeVersion) return;
  try { draft=await adapter.getDraft(id); } catch (error) { errorMessage=error.message; draft={id,document:seed,revision:0,savedAt:null}; }
  if (version !== routeVersion) return;
  // Identity, document and revision become visible together, only for the current route.
  state.guide=guide; state.error=errorMessage;
  state.document=structuredClone(draft.document); state.savedDocument=structuredClone(draft.document); state.revision=draft.revision; state.savedAt=draft.savedAt; state.dirty=false; state.conflict=null; state.remote=false; state.section=null; state.editVersion=0; reviewSummary='';
  const recovery=recoveryFor(id);
  if (recovery?.document?.id===id && JSON.stringify(recovery.document)!==JSON.stringify(draft.document)) {
    try { assertDocument(recovery.document,{baseline:seed}); } catch { return; }
    setTimeout(()=>{ if(version!==routeVersion || state.guide?.id!==id)return; showDialog(`<div class="dialog-heading"><span class="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h2>An unsaved edit is waiting.</h2></div><p>This tab kept a recovery copy when your last edit was interrupted. You can bring it back or keep the saved draft.</p><div class="dialog-actions">${button('restore-recovery','Restore my edit','primary')}${button('ignore-recovery','Use saved draft','quiet')}</div>`); },20);
  }
}
async function renderRoute() {
  const version=++routeVersion;
  const parts=(location.hash.replace(/^#\/?/,'')||'').split('/'); const page=parts[0]; activeHash=location.hash;
  try {
    if (page==='guide') { await openGuide(parts[1],version); if(version!==routeVersion)return; state.view=parts[2]||'edit'; if(state.view==='preview')previewView(); else if(state.view==='review')reviewView(); else {state.view='edit';renderEditor();} }
    else { state.view=page||'library'; if(page==='reviews')await queueView(version); else if(page==='review')await reviewDetail(parts[1],version); else if(page==='published')await publishedView(parts[1],version); else library(); }
    if(version!==routeVersion)return;
    document.title=`${state.view==='library'?'The editing workbench':state.view==='reviews'?'Review queue':state.view==='published'?(isLocal()?'Local publication':'Demo publication'):state.guide&&page==='guide'?nameOf(state.guide.id):'Guide review'} · PvME`;
  } catch(error) { if(version!==routeVersion)return; app.innerHTML=shell(`<div class="empty-state large">${icon('warning')}<h1>We couldn’t open that.</h1><p>${e(error.message)}</p><a class="button primary" href="#/">Back to the library</a><button class="button" data-action="reload">Try again</button></div>`); }
}
function renderCurrent() { if(state.view==='edit') renderEditor(); else if(state.view==='review')reviewView(); else if(state.view==='preview')previewView(); }
async function navigate(hash) {
  if (hash===location.hash) return;
  if(state.dirty) { await flushSave(); if(state.dirty) { showLeaveDialog(hash); return; } }
  if(dialog.open)dialog.close(); location.hash=hash; window.scrollTo(0,0);
}
function showLeaveDialog(hash) {
  showDialog(`<div class="dialog-heading"><span class="eyebrow">KEEP YOUR WORK SAFE</span><h2>Your edit has not saved.</h2></div><p>Stay here to retry or compare a newer draft. You can also download a recovery copy before leaving this page.</p><div class="dialog-actions">${button('close-dialog','Stay here','primary')}${button('download-leave','Download & leave','quiet',`data-next="${e(hash)}"`)}</div>`);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if(savePromise) { await savePromise; if(state.dirty&&!state.conflict&&!state.error) return flushSave(); return; }
  if(!state.dirty || state.conflict || !state.guide) return;
  const id=state.guide.id, document=structuredClone(state.document), editVersion=state.editVersion, revision=state.revision;
  state.saving=true; state.error=null; updateStatus();
  savePromise=(async()=>{
    try {
      const saved=await adapter.saveDraft(id,{baseRevision:revision,document});
      state.revision=saved.revision; state.savedAt=saved.savedAt; state.savedDocument=structuredClone(document); state.drafts.set(id,saved); state.remote=false;
      if(state.editVersion===editVersion){state.dirty=false;clearRecovery(id);} else saveRecovery();
      documentRevision();
    } catch(error) { if(error.status===409&&error.latest) state.conflict=error.latest; else state.error=error.message; saveRecovery(); }
    finally{state.saving=false;savePromise=null;updateStatus();}
  })();
  await savePromise;
  if(state.dirty&&!state.error&&!state.conflict) return flushSave();
}
function documentRevision(){ document.querySelectorAll('.revision').forEach(el=>el.textContent=`Revision ${state.revision}`); }
function editField(target) {
  const block=target.closest('[data-block-id]'); if(!block)return;
  const value=target.innerText.replace(/\r\n/g,'\n');
  state.document=updateTextNode(state.document,block.dataset.blockId,target.dataset.nodeId,value);state.editVersion++;state.dirty=true;
  if(!state.conflict)state.error=null; saveRecovery();
  block.classList.add('changed'); block.querySelector('.block-state').textContent='Edited';updateStatus();clearTimeout(saveTimer);saveTimer=setTimeout(flushSave,850);
}
function exportCurrent(document=state.document, metadata={revision:state.revision,summary:reviewSummary,mode:adapter.mode}) { if(!document)return; download(exportBundle(document,metadata),`pvme-${document.id}-r${metadata.revision??0}.zip`); toast('Exported source JSON, reading preview and review note.'); }
function downloadDraft() { download(new Blob([JSON.stringify({document:state.document,baseRevision:state.revision,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'}),`pvme-${state.guide.id}-recovery.json`); }
function resolveDialog() {
  const plan=conflictPlan(state.savedDocument,state.document,state.conflict.document); state.conflictChoices={};
  const overlaps=plan.filter(change=>change.overlap); state.conflictPlan=plan;
  showDialog(`<div class="dialog-heading"><span class="eyebrow">TWO EDITS, NO LOST WORK</span><h2>Choose what to keep.</h2></div><p>The other tab saved revision ${state.conflict.revision}. ${overlaps.length?`Choose a version for each of the ${overlaps.length} overlapping edits. Non-overlapping edits from both versions will be kept.`:'Your edits affect different text. Both versions can be combined without dropping a change.'}</p><div class="conflict-list">${overlaps.map((change,index)=>`<fieldset><legend>Overlapping text ${index+1}</legend><label class="conflict-option"><input type="radio" name="conflict-${e(change.id)}" data-conflict-id="${e(change.id)}" value="local"><span><strong>My edit</strong><span>${e(change.after)}</span></span></label><label class="conflict-option"><input type="radio" name="conflict-${e(change.id)}" data-conflict-id="${e(change.id)}" value="remote"><span><strong>Other tab</strong><span>${e(change.remote)}</span></span></label></fieldset>`).join('')}</div><div id="conflict-error" role="alert"></div><div class="dialog-actions">${button('apply-resolution',overlaps.length?'Save selected changes':'Combine & save both edits','primary')}${button('download-draft','Download my version','quiet')}</div><p class="dialog-note">We save only after you choose. If saving fails, your selected version stays on screen.</p>`,'conflict-dialog');
}

async function action(name, target) {
  const actionVersion = routeVersion;
  switch(name){
    case 'how':howItWorks();break;
    case 'close-dialog':dialog.close();break;
    case 'reload':await renderRoute();break;
    case 'export':exportCurrent();break;
    case 'download-draft':downloadDraft();break;
    case 'download-leave':downloadDraft();saveRecovery();state.dirty=false;state.guide=null;state.document=null;state.savedDocument=null;state.error=null;state.conflict=null;state.remote=false;dialog.close();location.hash=target.dataset.next;break;
    case 'retry':if(state.dirty){state.error=null;await flushSave();}else{state.guide=null;await renderRoute();}break;
    case 'load-remote':if(state.dirty){await flushSave();if(state.conflict)resolveDialog();}else{const latest=await adapter.getDraft(state.guide.id);if(actionVersion!==routeVersion)return;state.document=latest.document;state.savedDocument=structuredClone(latest.document);state.revision=latest.revision;state.savedAt=latest.savedAt;state.remote=false;renderCurrent();toast('Loaded the newer saved draft.');}break;
    case 'resolve':resolveDialog();break;
    case 'apply-resolution':{
      const overlaps=state.conflictPlan.filter(change=>change.overlap);if(overlaps.some(change=>!state.conflictChoices[change.id])){document.querySelector('#conflict-error').textContent='Choose which version to keep for every overlapping edit.';return;}
      const latest=state.conflict;
      state.document=resolveConflict(latest.document,state.conflictPlan,state.conflictChoices);state.savedDocument=structuredClone(latest.document);state.revision=latest.revision;state.conflict=null;state.dirty=true;state.editVersion++;saveRecovery();await flushSave();
      if(state.dirty){if(state.conflict)resolveDialog();else{dialog.close();renderCurrent();}}else{dialog.close();renderCurrent();toast('Both versions reconciled. Your chosen changes are saved.');}break;
    }
    case 'restore-recovery':{const recovery=recoveryFor(state.guide.id);if(recovery){assertDocument(recovery.document,{baseline:state.seeds.get(state.guide.id)});state.document=recovery.document;state.savedDocument=recovery.base||state.savedDocument;state.dirty=true;state.editVersion++;if(recovery.revision!==state.revision)state.conflict=await adapter.getDraft(state.guide.id);else state.revision=recovery.revision;}dialog.close();renderCurrent();if(!state.conflict)await flushSave();break;}
    case 'ignore-recovery':clearRecovery(state.guide.id);dialog.close();break;
    case 'previous-section':case 'next-section':{const sections=sectionsOf(state.document),index=sections.findIndex(section=>section.id===state.section),next=sections[index+(name==='next-section'?1:-1)];if(next){state.section=next.id;renderEditor();document.querySelector('.editing-panel').scrollIntoView({block:'start'});}break;}
    case 'submit-review':{
      reviewSummary=document.querySelector('#review-summary').value.trim();if(!reviewSummary){document.querySelector('#review-summary').focus();toast('Add a short note about what changed.');return;}
      if(!changes().length)return;await flushSave();if(state.dirty){updateStatus();toast('Save or resolve your draft before creating a review.');return;}
      if(actionVersion!==routeVersion)return;
      const review=await adapter.submitReview(state.guide.id,{baseRevision:state.revision,summary:reviewSummary});state.reviews.unshift(review);toast(isLocal()?'Review snapshot created.':'Demo review created. It stays in this browser.');if(actionVersion!==routeVersion)return;await navigate(href(`review/${review.id}`));break;
    }
    case 'publish-review':{
      const result=await adapter.publishReview(state.activeReview.id);toast(isLocal()?'Snapshot committed to the local sandbox.':'Demo preview published in this browser only.');if(actionVersion!==routeVersion)return;await navigate(href(`published/${result.guideId}`));break;
    }
    case 'export-review':exportCurrent(state.activeReview.document,{revision:state.activeReview.baseRevision,summary:state.activeReview.summary,mode:adapter.mode});break;
    case 'export-published':exportCurrent(state.publication.document,{revision:state.publication.revision,summary:'Published snapshot',mode:adapter.mode});break;
  }
}

document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();document.querySelector('#main')?.focus();return;}
  const fragment=event.target.closest('.guide-content a[href^="#"]');if(fragment){event.preventDefault();const id=fragment.getAttribute('href').slice(1);document.getElementById(id)?.scrollIntoView({block:'start'});return;}
  if(event.target.closest('.edit-block a'))event.preventDefault();
  const link=event.target.closest('a[href^="#/"]');if(link&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey){event.preventDefault();await navigate(link.getAttribute('href'));return;}
  const filter=event.target.closest('[data-filter]');if(filter){state.filter=filter.dataset.filter;library();return;}
  const section=event.target.closest('[data-section]');if(section){state.section=section.dataset.section;renderEditor();return;}
  const target=event.target.closest('[data-action]');if(!target||target.disabled)return;
  const name=target.dataset.action, clickVersion=routeVersion;target.disabled=true;
  try{await action(name,target);}catch(error){if(clickVersion!==routeVersion){toast(error.message);return;}if(error.status===409&&error.latest&&state.guide){state.conflict=error.latest;updateStatus();resolveDialog();}else{showDialog(`<div class="dialog-heading"><span class="eyebrow">ACTION NOT COMPLETED</span><h2>Let’s keep your work safe.</h2></div><p>${e(error.message)}</p>${button('close-dialog','Back to my work','primary')}`);}}finally{if(target.isConnected)target.disabled=false;}
});
document.addEventListener('input',event=>{
  if(event.target.matches('[data-node-id]'))editField(event.target);
  else if(event.target.id==='review-summary')reviewSummary=event.target.value;
  else if(event.target.id==='guide-search'){const start=event.target.selectionStart;state.query=event.target.value;library();const input=document.querySelector('#guide-search');input.focus();try{input.setSelectionRange(start,start);}catch{}}
});
document.addEventListener('change',event=>{if(event.target.id==='section-select'){state.section=event.target.value;renderEditor();}if(event.target.matches('[data-conflict-id]'))state.conflictChoices[event.target.dataset.conflictId]=event.target.value;});
document.addEventListener('beforeinput',event=>{if(!event.target.matches('[data-node-id]'))return;const selection=window.getSelection();if(selection.rangeCount&&!event.target.contains(selection.getRangeAt(0).commonAncestorContainer)){event.preventDefault();toast('Edit one text field at a time to keep icons and links intact.');}});
document.addEventListener('drop',event=>{if(event.target.closest('.edit-block'))event.preventDefault();});
document.addEventListener('paste',event=>{if(!event.target.matches('[data-node-id]'))return;event.preventDefault();const value=event.clipboardData.getData('text/plain');const selection=window.getSelection();if(!selection.rangeCount)return;const range=selection.getRangeAt(0);if(!event.target.contains(range.commonAncestorContainer)){toast('Paste into one text field at a time.');return;}range.deleteContents();const node=document.createTextNode(value);range.insertNode(node);range.setStartAfter(node);range.collapse(true);selection.removeAllRanges();selection.addRange(range);editField(event.target);});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='s'){event.preventDefault();flushSave();}if(event.target.matches('[data-node-id]')&&(event.metaKey||event.ctrlKey)&&['b','i','u'].includes(event.key.toLowerCase()))event.preventDefault();});
window.addEventListener('beforeunload',event=>{if(state.dirty||state.saving){saveRecovery();event.preventDefault();event.returnValue='';}});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.dirty)flushSave();});
window.addEventListener('hashchange',async()=>{if(state.dirty){await flushSave();if(state.dirty){const next=location.hash;history.replaceState(null,'',`${location.pathname}${location.search}${activeHash}`);showLeaveDialog(next);return;}}await renderRoute();});

async function start(){
  const response=await fetch(new URL('../content/catalog.json',import.meta.url));if(!response.ok)throw new Error('The guide library could not load.');state.catalog=await response.json();
  if(new URLSearchParams(location.search).get('service')==='local')adapter=await new ServiceAdapter().connect();else adapter=new DeviceAdapter({loadSeed});
  if(adapter.onChange)adapter.onChange(async message=>{if(message.type==='draft'&&state.guide?.id===message.id&&message.revision>state.revision){state.remote=true;updateStatus();}});
  await Promise.all(state.catalog.map(async guide=>{try{state.drafts.set(guide.id,await adapter.getDraft(guide.id));}catch{}}));
  try{state.reviews=(await adapter.listReviews()).reviews;}catch{}
  await renderRoute();
}
start().catch(error=>{app.innerHTML=`<main class="boot fatal">${rune}<h1>The workbench could not open.</h1><p>${e(error.message)}</p>${new URLSearchParams(location.search).get('service')==='local'?'<p>The local service must be running on this origin. No automatic switch was made to browser storage.</p><a class="button primary" href="./">Open device-only demo instead</a>':'<button class="button primary" onclick="location.reload()">Try again</button>'}</main>`;});
