import { renderDocument } from '../shared/model.mjs';
import { escapeHTML } from './document.mjs';
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let i=0;i<8;i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
function header(size) { const bytes = new Uint8Array(size); return [bytes, new DataView(bytes.buffer)]; }
export function zipFiles(files) {
  const chunks = [], directory = []; let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path), body = encoder.encode(content), crc = crc32(body);
    const [local, l] = header(30); l.setUint32(0,0x04034b50,true); l.setUint16(4,20,true); l.setUint16(6,0x800,true); l.setUint32(14,crc,true); l.setUint32(18,body.length,true); l.setUint32(22,body.length,true); l.setUint16(26,name.length,true);
    const [central,c] = header(46); c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0x800,true); c.setUint32(16,crc,true); c.setUint32(20,body.length,true); c.setUint32(24,body.length,true); c.setUint16(28,name.length,true); c.setUint32(42,offset,true);
    chunks.push(local,name,body); directory.push(central,name); offset += local.length + name.length + body.length;
  }
  const centralSize = directory.reduce((sum,part)=>sum+part.length,0), [end,e] = header(22);
  e.setUint32(0,0x06054b50,true); e.setUint16(8,Object.keys(files).length,true); e.setUint16(10,Object.keys(files).length,true); e.setUint32(12,centralSize,true); e.setUint32(16,offset,true);
  return new Blob([...chunks,...directory,end], { type: 'application/zip' });
}
export function publishedHTML(document) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(document.title)} · PvME draft</title><style>body{max-width:800px;margin:40px auto;padding:0 22px;font:16px/1.8 system-ui;background:#f7f5ed;color:#253b32}img{max-width:100%;height:auto}.d-emoji,.emoji,.ability-icon{height:1.6em;max-width:2em;vertical-align:middle}a{color:inherit}table,pre{display:block;overflow:auto}iframe,video{max-width:100%}header,footer{padding:20px 0;border-block:1px solid #ccd1c1}.notice{font-size:14px;color:#6e654c}h1,h2,h3{line-height:1.3}</style></head><body><header><strong>PvME · Exported guide snapshot</strong><p class="notice">A prototype export, not a live PvME publication. Source content remains attributed to its original contributors.</p></header><main>${renderDocument(document,{readerBaseUrl:'https://pvme-preview.vercel.app'})}</main><footer><a href="${escapeHTML(document.source.url)}">Original source</a> · ${escapeHTML(document.source.attribution || 'PvM Encyclopedia contributors')} · <a href="${escapeHTML(document.source.licenseUrl || 'https://creativecommons.org/licenses/by-nc-sa/4.0/')}">${escapeHTML(document.source.license || 'See source license')}</a></footer></body></html>`;
}
export function exportBundle(document, { revision = 0, summary = '', mode = 'device-only' } = {}) {
  return zipFiles({
    [`content/${document.id}.json`]: JSON.stringify(document, null, 2) + '\n',
    [`preview/${document.id}.html`]: publishedHTML(document),
    'review.json': JSON.stringify({ guideId: document.id, revision, summary, mode, exportedAt: new Date().toISOString(), publishedToGitHub: false, publishedToLiveSite: false }, null, 2) + '\n',
    'README.md': `# ${document.title}\n\nA Git-ready source snapshot from the PvME editing prototype.\n\n- Canonical document: content/${document.id}.json\n- Reading preview: preview/${document.id}.html\n- Review metadata: review.json\n\nNothing in this download has been pushed to GitHub or published to the live PvME site. Place these files in a review branch of the prototype repository, validate with editor/shared/model.mjs against the bundled original, and review the diff before committing. This JSON schema is the prototype's content format, not a drop-in replacement for upstream PvME Markdown. The HTML preview requires an internet connection for original externally hosted images and media.\n\nSummary: ${summary || 'Unsubmitted draft'}\n\nOriginal source: ${document.source.url}\nAttribution: ${document.source.attribution || 'PvM Encyclopedia contributors'}\nLicense: ${document.source.license || 'See original source'}\n${document.source.licenseUrl || ''}\n`
  });
}
export function download(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
