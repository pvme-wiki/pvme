import fs from 'node:fs';
import assert from 'node:assert/strict';
import { validateDocument, getEditableTextNodes, updateTextNode, renderDocument } from '../editor/shared/model.mjs';
import { readSnapshot } from './reader-snapshot.mjs';
const catalog=JSON.parse(fs.readFileSync('editor/content/catalog.json'));
assert.equal(catalog.length,323); assert.equal(new Set(catalog.map(x=>x.id)).size,323);
const files=readSnapshot('.'); let edited=0, total=0, editable=0, rendered=[];
for(const item of catalog){
 const doc=JSON.parse(fs.readFileSync(`editor/content/${item.file}`));
 const v=validateDocument(doc,{baseline:doc}); assert.ok(v.valid,`${item.id}: ${v.errors.join('; ')}`);
 assert.ok(files.has(`exports/${doc.source.articleId}.wiki`),`${item.id}: missing export`);
 for(const block of doc.blocks){
  const walk=n=>{if(n.type==='text')total+=n.text.length; else n.children.forEach(walk)};walk(block.node);
  for(const n of getEditableTextNodes(block))editable+=n.text.length;
 }
 const b=doc.blocks.find(x=>getEditableTextNodes(x).length);
 if(b){const n=getEditableTextNodes(b)[0], editedDoc=updateTextNode(doc,b.id,n.id,n.text+' EDIT SENTINEL');assert.ok(validateDocument(editedDoc,{baseline:doc}).valid);assert.ok(renderDocument(editedDoc).includes('EDIT SENTINEL'));const malicious=structuredClone(editedDoc);malicious.source.url='https://example.com/';assert.equal(validateDocument(malicious,{baseline:doc}).valid,false);edited++;}
 rendered.push([item.id,renderDocument(doc)]);
}
if(process.argv.includes('--render'))process.stdout.write(JSON.stringify(rendered));
else console.log(JSON.stringify({guides:catalog.length,edited,totalTextCharacters:total,editableTextCharacters:editable}));
