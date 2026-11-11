import { assertDocument, escapeHtml } from '../editor/shared/model.mjs';
// Conservative draft conversion: preserve literal text and source attribution.
// MediaWiki templates and asset import rights still require target-side review.
function nodeWiki(node) {
  if (node.type === 'text') return `<nowiki>${escapeHtml(node.text)}</nowiki>`;
  const body = node.children.map(nodeWiki).join('');
  const tag = node.tag;
  if (/^h[1-6]$/.test(tag)) { const marks = '='.repeat(Math.max(2, Number(tag[1]))); return `\n\n${marks} ${body} ${marks}\n`; }
  if (tag === 'a') return `[${node.attrs.href || ''} ${body}]`;
  if (tag === 'img') return `[${node.attrs.src} ${escapeHtml(node.attrs.alt || 'Source image')}]`;
  if (tag === 'iframe') return `[${node.attrs.src} Embedded video]`;
  if (tag === 'br') return '<br>\n';
  if (tag === 'hr') return '\n----\n';
  if (['strong', 'b'].includes(tag)) return `'''${body}'''`;
  if (['em', 'i'].includes(tag)) return `''${body}''`;
  if (['p', 'div', 'section', 'article', 'details'].includes(tag)) return `\n\n${body}\n`;
  if (tag === 'summary') return `\n'''${body}'''\n`;
  if (['ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'sup', 'sub', 'blockquote'].includes(tag)) return `<${tag}>${body}</${tag}>`;
  return body;
}
export function mediaWikiDraft(document) {
  assertDocument(document);
  return `<!-- MediaWiki draft: review templates, tables, links and media before import. -->\n= <nowiki>${escapeHtml(document.title)}</nowiki> =\n` + document.blocks.map(b => nodeWiki(b.node) + (b.tail ? nodeWiki(b.tail) : '')).join('') + `\n\n== Source and licence ==\nAdapted from [${document.source.url} PvME contributors], [${document.source.licenseUrl} ${document.source.license}]. Source captured ${document.source.retrieved}. This draft includes reviewed changes in this independent edition. Media rights are separate.\n`;
}
