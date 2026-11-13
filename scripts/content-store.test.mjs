import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { documentHash } from '../server/core.mjs';
import { GUIDE_STORE_DOCUMENTATION, GUIDE_STORE_LIMITS, guideStoreSha256, validateGuidePin, validateGuideManifest, validateGuideStore, serializeGuideManifest, updateGuideManifest } from '../server/content-store.mjs';
import { archiveGuideSeed, writeGuideSeed } from './prepare-guide-seed.mjs';
import { fetchGuideStore } from './fetch-guide-store.mjs';
const baselineBytes = fs.readFileSync(new URL('../editor/content/arch-glacor-basic.json', import.meta.url));
const original = JSON.parse(baselineBytes);
const gitBlob = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
function fixture({ authority = [original.id] } = {}) {
 const expectedBaselines=new Map([[original.id,structuredClone(original)]]),expectedCatalogBytes=Buffer.from(JSON.stringify([{id:original.id,file:original.id+'.json',title:original.title,category:'Boss fundamentals',summary:'Public guide summary'}]));
 const document=structuredClone(original);document.title+=' reviewed';const guideBytes=Buffer.from(JSON.stringify(document,null,2)+'\n');
 const manifest={schemaVersion:1,origin:'guides-v1',catalog:{path:'baselines/catalog.json',sha256:guideStoreSha256(expectedCatalogBytes)},baselines:{[original.id]:{path:`baselines/${original.id}.json`,sha256:guideStoreSha256(baselineBytes),contentHash:documentHash(original)}},guides:{[original.id]:{path:`guides/${original.id}.json`,sha256:guideStoreSha256(guideBytes),contentHash:documentHash(document),baselineHash:documentHash(original),revision:2}}};
 const manifestBytes=serializeGuideManifest(manifest),files=new Map([...GUIDE_STORE_DOCUMENTATION].map(([file,bytes])=>[file,Buffer.from(bytes)]));files.set('manifest.json',manifestBytes);files.set('baselines/catalog.json',expectedCatalogBytes);files.set(`baselines/${original.id}.json`,Buffer.from(baselineBytes));files.set(`guides/${original.id}.json`,guideBytes);
 const pin={schemaVersion:1,mode:'shadow',origin:'guides-v1',repository:{id:123456,owner:'pvme-wiki',repo:'guides',base:'main'},contentCommit:'c'.repeat(40),manifestSha256:guideStoreSha256(manifestBytes),guideIds:authority};
 return {pin,manifest,manifestBytes,files,expectedBaselines,expectedCatalogBytes,document};
}
function reseal(f){f.manifestBytes=serializeGuideManifest(f.manifest);f.pin.manifestSha256=guideStoreSha256(f.manifestBytes);f.files.set('manifest.json',f.manifestBytes);return f;}
function mockProvider(f,{baseHead=f.pin.contentCommit,change}={}){
 const blobs=new Map([...f.files].map(([file,bytes])=>[gitBlob(bytes),{file,bytes}]));
 const entries=[{path:'baselines',type:'tree',mode:'040000',sha:'e'.repeat(40)},{path:'guides',type:'tree',mode:'040000',sha:'f'.repeat(40)},...[...f.files].map(([file,bytes])=>({path:file,type:'blob',mode:'100644',sha:gitBlob(bytes),size:bytes.length}))];
 const calls=[];const repo=`/repos/${f.pin.repository.owner}/${f.pin.repository.repo}`;
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});const route=new URL(url).pathname+new URL(url).search;let value,status=200;
  if(route===repo)value={id:f.pin.repository.id,private:true,full_name:`${f.pin.repository.owner}/${f.pin.repository.repo}`};
  else if(route===repo+'/git/ref/heads/main')value={ref:'refs/heads/main',object:{type:'commit',sha:baseHead}};
  else if(route===repo+`/git/commits/${f.pin.contentCommit}`)value={sha:f.pin.contentCommit,tree:{sha:'d'.repeat(40)}};
  else if(route===repo+`/compare/${f.pin.contentCommit}...${baseHead}`)value={status:'ahead',base_commit:{sha:f.pin.contentCommit},merge_base_commit:{sha:f.pin.contentCommit}};
  else if(route===repo+'/git/trees/'+ 'd'.repeat(40)+'?recursive=1')value={sha:'d'.repeat(40),truncated:false,tree:structuredClone(entries)};
  else if(route.startsWith(repo+'/git/blobs/')){const sha=route.slice((repo+'/git/blobs/').length),blob=blobs.get(sha);if(blob)value={sha,size:blob.bytes.length,encoding:'base64',content:blob.bytes.toString('base64')};else{status=404;value={message:'not found'};}}
  else{status=404;value={message:'unknown route'};}
  const altered=change?.({route:route.slice(repo.length),value,status});if(altered){value=altered.value??value;status=altered.status??status;}
  return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 };
 return {calls,fetchImpl};
}
const fetchFixture=(f,mock,extra={})=>fetchGuideStore({...f,fetchImpl:mock.fetchImpl,getToken:({repository,permissions})=>{assert.deepEqual(repository,f.pin.repository);assert.deepEqual(permissions,{contents:'read'});return 'test-read-only-token';},...extra});
test('payload validation retains exact baseline/catalog/overlay bytes and permits a partial shadow authority list',()=>{
 const f=fixture({authority:[]}),store=validateGuideStore(f);assert.equal(store.baseline.size,1);assert.equal(store.guides.size,1);assert.deepEqual(store.files.get(`baselines/${original.id}.json`),baselineBytes);assert.deepEqual(store.files.get('baselines/catalog.json'),f.expectedCatalogBytes);assert.deepEqual(store.guides.get(original.id).document,f.document);assert.deepEqual(store.pin.guideIds,[]);
 assert.ok(![...store.files.keys()].some(file=>/review|source|reader|\.git|script|asset/.test(file)));
 for(const file of store.files.keys())assert.ok(!file.includes('..'));
});
test('pin, manifest and sealed baseline/catalog contracts reject hostile fields, identities and provenance',()=>{
 for(const mutate of [p=>p.contentCommit='main',p=>p.repository.id='123456',p=>p.repository.base='../main',p=>p.origin='legacy',p=>p.guideIds=[original.id,original.id],p=>p.secret='private']){const f=fixture();mutate(f.pin);assert.throws(()=>validateGuidePin(f.pin));}
 const f=fixture();assert.throws(()=>validateGuidePin(f.pin,{expectedRepository:{...f.pin.repository,id:999}}),/different repository/);
 for(const mutate of [m=>m.catalog.sha256='0'.repeat(64),m=>m.baselines[original.id].path='../bad.json',m=>m.baselines[original.id].contentHash='0'.repeat(64),m=>m.guides[original.id].reviewNote='private',m=>m.guides[original.id].baselineHash='0'.repeat(64),m=>delete m.baselines[original.id],m=>m.guides['unknown-guide']=m.guides[original.id]]){const v=fixture();mutate(v.manifest);assert.throws(()=>validateGuideManifest(v.manifest,v));}
 const changed=fixture();const doc=JSON.parse(changed.files.get(`baselines/${original.id}.json`));doc.source.attribution='Changed author';const bytes=Buffer.from(JSON.stringify(doc));changed.files.set(`baselines/${original.id}.json`,bytes);changed.manifest.baselines[original.id].sha256=guideStoreSha256(bytes);reseal(changed);assert.throws(()=>validateGuideStore(changed),/immutable application document|Original/);
});
test('payload rejects private reviews, executable files, missing inventory, hash changes and oversized files',()=>{
 for(const file of ['content/reviews/private.json','reader/reader-snapshot.json.gz','scripts/build.mjs','../escape.json','baselines/nested/guide.json']){const f=fixture();f.files.set(file,Buffer.from('private'));assert.throws(()=>validateGuideStore(f),/unexpected files/);}
 const missing=fixture();missing.files.delete(`guides/${original.id}.json`);assert.throws(()=>validateGuideStore(missing),/unexpected files/);
 const drift=fixture();drift.files.get(`guides/${original.id}.json`)[0]=32;assert.throws(()=>validateGuideStore(drift),/manifest/);
 const big=fixture();big.files.set(`guides/${original.id}.json`,Buffer.alloc(GUIDE_STORE_LIMITS.fileBytes+1));assert.throws(()=>validateGuideStore(big),/payload size/);
 const badManifest=fixture();badManifest.pin.manifestSha256='0'.repeat(64);assert.throws(()=>validateGuideStore(badManifest),/immutable content pin/);
});
test('publication manifest updates are deterministic, preserve unrelated entries and require exact parent revision',()=>{
 const f=fixture(),next=structuredClone(f.document);next.title+=' next';const options={expectedBaselines:f.expectedBaselines,expectedCatalogBytes:f.expectedCatalogBytes};
 const a=updateGuideManifest(f.manifest,{guideId:original.id,document:next,baselineHash:documentHash(f.document),revision:3},options);
 const b=updateGuideManifest(f.manifest,{guideId:original.id,document:JSON.parse(JSON.stringify(next)),baselineHash:documentHash(f.document),revision:3},options);
 assert.deepEqual(a.manifestBytes,b.manifestBytes);assert.equal(a.manifestSha256,guideStoreSha256(a.manifestBytes));assert.deepEqual(a.manifest.catalog,f.manifest.catalog);assert.deepEqual(a.manifest.baselines,f.manifest.baselines);assert.equal(a.manifest.guides[original.id].sha256,guideStoreSha256(a.guideBytes));assert.equal(a.manifest.guides[original.id].contentHash,documentHash(next));assert.equal(f.manifest.guides[original.id].revision,2);
 assert.throws(()=>updateGuideManifest(f.manifest,{guideId:original.id,document:next,baselineHash:'0'.repeat(64),revision:3},options),/current content-store revision/);
 assert.throws(()=>updateGuideManifest(f.manifest,{guideId:original.id,document:next,baselineHash:documentHash(f.document),revision:4},options),/current content-store revision/);
});
test('fetch uses only pinned Git objects, exact private identity and read-only requests',async()=>{
 const f=fixture(),mock=mockProvider(f,{baseHead:'b'.repeat(40)}),store=await fetchFixture(f,mock);
 assert.equal(store.proof.contentCommit,f.pin.contentCommit);assert.equal(store.proof.baseHead,'b'.repeat(40));assert.deepEqual(store.files.get(`guides/${original.id}.json`),f.files.get(`guides/${original.id}.json`));assert.deepEqual(store.baseline.get(original.id),original);
 assert.ok(mock.calls.every(call=>call.options.method==='GET'&&call.options.redirect==='error'&&new URL(call.url).origin==='https://api.github.com'));
 assert.equal(mock.calls.filter(call=>call.url.includes('/git/ref/')).length,1);assert.ok(mock.calls.every(call=>!call.url.includes('/contents/')&&!call.url.includes('/commits/main')));
});
test('failed identity, branch ancestry or pinned commit never fall back to a branch tip',async()=>{
 const changes=[({route,value})=>route===''?{value:{...value,id:999}}:null,({route,value})=>route===''?{value:{...value,private:false}}:null,({route,value})=>route.startsWith('/git/ref/')?{value:{...value,ref:'refs/heads/other'}}:null,({route})=>route.startsWith('/git/commits/')?{status:404}:null,({route,value})=>route.startsWith('/compare/')?{value:{...value,status:'behind'}}:null];
 for(const change of changes){const f=fixture(),mock=mockProvider(f,{baseHead:'b'.repeat(40),change});await assert.rejects(fetchFixture(f,mock));assert.ok(!mock.calls.some(call=>call.url.includes('/git/blobs/')));assert.ok(!mock.calls.some(call=>call.url.includes('/commits/main')));}
});
test('fetch rejects symlinks, submodules, scripts, truncated trees, duplicate paths and excessive aggregate size before reading payload blobs',async()=>{
 const mutations=[v=>v.truncated=true,v=>v.tree.push({path:'evil.mjs',type:'blob',mode:'100644',sha:'1'.repeat(40),size:10}),v=>v.tree[2].mode='120000',v=>v.tree.push({path:'guides',type:'commit',mode:'160000',sha:'1'.repeat(40),size:1}),v=>v.tree.push(v.tree[2]),v=>v.tree.push(v.tree[0]),v=>{for(let i=0;i<21;i++)v.tree.push({path:`guides/oversize-${i}.json`,type:'blob',mode:'100644',sha:'1'.repeat(40),size:5_000_000});}];
 for(const mutate of mutations){const f=fixture(),mock=mockProvider(f,{change:({route,value})=>{if(route.startsWith('/git/trees/'))mutate(value);return {value};}});await assert.rejects(fetchFixture(f,mock));assert.ok(!mock.calls.some(call=>call.url.includes('/git/blobs/')));}
});
test('fetch rejects corrupt provider bytes and redacts provider and credential errors',async()=>{
 const f=fixture();for(const change of [({route,value})=>route.startsWith('/git/blobs/')?{value:{...value,content:'%%%not-base64'}}:null,({route,value})=>route.startsWith('/git/blobs/')?{value:{...value,sha:'0'.repeat(40)}}:null]){const mock=mockProvider(f,{change});await assert.rejects(fetchFixture(f,mock),/invalid representation/);}
 await assert.rejects(fetchGuideStore({...f,getToken:()=>{throw Error('SECRET_TOKEN_DO_NOT_PRINT');}}),error=>!error.message.includes('SECRET_TOKEN_DO_NOT_PRINT')&&error.code==='credentials_unavailable');
 const mock=mockProvider(f,{change:()=>({status:403,value:{message:'SECRET_PROVIDER_DO_NOT_PRINT'}})});await assert.rejects(fetchFixture(f,mock),error=>!error.message.includes('SECRET_PROVIDER_DO_NOT_PRINT'));
});
test('local seed archive is deterministic and output cannot overwrite tracked files or traverse links',t=>{
 const f=fixture(),archive=archiveGuideSeed(f.files);assert.deepEqual(archiveGuideSeed(f.files),archive);const tar=gunzipSync(archive);assert.ok(tar.includes(Buffer.from('manifest.json')));assert.ok(!tar.includes(Buffer.from('content/reviews/')));
 assert.throws(()=>archiveGuideSeed(new Map([['../../private',Buffer.from('bad')]])),/unsupported paths/);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pvme-seed-output-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const seed={files:f.files,summary:{baselineCount:1,overlayCount:1,fileCount:f.files.size}};
 assert.throws(()=>writeGuideSeed(seed,path.join(root,'tracked-output'),{root}),/ignored/);
 fs.mkdirSync(path.join(root,'.runtime'));fs.symlinkSync(os.tmpdir(),path.join(root,'.runtime','linked'));assert.throws(()=>writeGuideSeed(seed,path.join(root,'.runtime','linked','escape'),{root}),/regular directories/);
 const output=path.join(root,'.runtime','seed');const audit=writeGuideSeed(seed,output,{root});assert.equal(audit.archiveSha256,guideStoreSha256(archive));assert.deepEqual(fs.readFileSync(path.join(output,'payload',`baselines/${original.id}.json`)),baselineBytes);assert.throws(()=>writeGuideSeed(seed,output,{root}),/new output/);
});
