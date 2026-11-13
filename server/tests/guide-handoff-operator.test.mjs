import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './harness.mjs';
import { migrate } from '../manage.mjs';
import { prepareGuideHandoff } from '../guide-store-operator.mjs';
const legacy={pipeline:'legacy-v1',origin:'legacy-v1',repository:{id:'101',owner:'example',repo:'private-guides',base:'main'},installationId:'12345'};
async function prepared(t){
 const f=await fixture();t.after(()=>f.db.close());await migrate(f.db,{legacyTarget:legacy});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pvme-handoff-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(file,value)=>{const full=path.join(root,file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,JSON.stringify(value));};
 const pin={schemaVersion:1,mode:'shadow',origin:'guides-v1',repository:{id:202,owner:'pvme-wiki',repo:'guides',base:'main'},contentCommit:'c'.repeat(40),manifestSha256:'d'.repeat(64),guideIds:[]};
 write('content/guide-store.json',pin);write('editor/content/catalog.json',[{id:f.guide.id,file:f.guide.id+'.json'}]);write('editor/content/'+f.guide.id+'.json',f.guide);
 const env={GUIDE_STORE_STAGE:'active',GITHUB_REPOSITORY_ID:'101',GITHUB_OWNER:'example',GITHUB_REPO:'private-guides',GITHUB_BASE_BRANCH:'main',GITHUB_INSTALLATION_ID:'12345',GUIDE_STORE_REPOSITORY_ID:'202',GUIDE_STORE_OWNER:'pvme-wiki',GUIDE_STORE_REPO:'guides',GUIDE_STORE_BASE_BRANCH:'main',GUIDE_STORE_INSTALLATION_ID:'67890'};
 const store={pin,guides:new Map(),baseline:new Map([[f.guide.id,f.guide]])};
 return{...f,root,env,store,options:{guideId:f.guide.id,reason:'Synthetic staged handoff',env,fetchStore:async()=>store}};
}
test('protected handoff prepares a read-only exact-revision plan and applies only through fenced operator action',async t=>{
 const f=await prepared(t),ready=await prepareGuideHandoff(f.db,f.root,f.options);
 assert.equal(ready.plan.expectedRevision,1);assert.equal((await f.db.query('SELECT target FROM guide_publication_authority WHERE guide_id=$1',[f.guide.id])).rows[0].target.pipeline,'legacy-v1');
 assert.equal((await ready.apply()).changed,true);assert.equal((await ready.apply()).changed,false);
});
test('same document hash with a different remote revision cannot authorize handoff',async t=>{
 const f=await prepared(t);f.store.guides.set(f.guide.id,{document:f.guide,revision:2});
 await assert.rejects(prepareGuideHandoff(f.db,f.root,f.options),/editing revision/);
 assert.equal((await f.db.query('SELECT target FROM guide_publication_authority WHERE guide_id=$1',[f.guide.id])).rows[0].target.pipeline,'legacy-v1');
});
test('wrong legacy binding and inactive stage stop before any remote handoff preparation',async t=>{
 const f=await prepared(t);let reads=0;
 await assert.rejects(prepareGuideHandoff(f.db,f.root,{...f.options,env:{...f.env,GITHUB_REPOSITORY_ID:'999'},fetchStore:async()=>{reads++;return f.store;}}),/original repository/);
 await assert.rejects(prepareGuideHandoff(f.db,f.root,{...f.options,env:{...f.env,GUIDE_STORE_STAGE:'shadow'},fetchStore:async()=>{reads++;return f.store;}}),/active-stage/);assert.equal(reads,0);
});
