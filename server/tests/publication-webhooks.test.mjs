import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fixture } from './harness.mjs';
import { migrate } from '../manage.mjs';
import { createService } from '../service.mjs';
import { createHandler } from '../http.mjs';
import { handoffGuidePublication } from '../publication-targets.mjs';
import { documentHash } from '../core.mjs';
const legacy={pipeline:'legacy-v1',origin:'legacy-v1',repository:{id:'101',owner:'example',repo:'private-guides',base:'main'},installationId:'12345'};
const content={pipeline:'content-pin-v1',origin:'guides-v1',repository:{id:'202',owner:'pvme-wiki',repo:'guides',base:'main'},installationId:'67890'};
const registry=[{...legacy,appRepository:legacy.repository},{...content,appRepository:legacy.repository}];
async function prepared(t) {
 const f=await fixture();t.after(()=>f.db.close());await migrate(f.db,{legacyTarget:legacy});
 const owner=await f.user(),reviewer=await f.user('moderator');
 const service=createService(f.db,{publicationEnabled:true,publicationTargets:registry,defaultPublicationTarget:legacy});
 const other=(await service.getGuide('interface-guide')).document;
 async function approved(guide){await service.saveDraft(owner.id,guide.id,{document:{...structuredClone(guide),title:guide.title+' reviewed'},expectedVersion:0,baseRevision:1});const row=await service.submit(owner.id,guide.id,{expectedVersion:1,summary:'Exact reviewed wording'});await service.review(reviewer.id,row.id,{decision:'approve',expectedVersion:1,note:'Checked'});return row.id;}
 const oldId=await approved(other);
 await handoffGuidePublication(f.db,{guideId:f.guide.id,target:content,expectedRevision:1,expectedHash:documentHash(f.guide),contentCommit:'c'.repeat(40),verifyContent:async()=>true,reason:'Synthetic staged handoff'});
 const newId=await approved(f.guide);
 await f.db.query("UPDATE publication_jobs SET state='awaiting_merge',available_at=now()+interval '1 day'");
 const config={...f.config,publicationTargets:registry,defaultPublicationTarget:legacy,github:{...f.config.github,id:101},guideStore:{origin:'guides-v1',app:{id:101},content:{...content.repository,id:202,installationId:content.installationId,webhookSecret:'content-webhook-secret-abcdefghijklmnopqrstuvwxyz'}}};
 function event(target,delivery='synthetic-delivery-shared-123',override={}) {
 const isContent=target==='content',repo=isContent?content:legacy;const raw=Buffer.from(JSON.stringify({repository:{id:Number(repo.repository.id),full_name:repo.repository.owner+'/'+repo.repository.repo,private:true},installation:{id:Number(repo.installationId)},...override}));
 const signature='sha256='+createHmac('sha256',isContent?config.guideStore.content.webhookSecret:config.github.webhookSecret).update(raw).digest('hex');
 return new Request(config.origin+'/api/editor/webhooks/github',{method:'POST',headers:{'x-hub-signature-256':signature,'x-github-delivery':delivery,'x-github-event':'push'},body:raw});
 }
 return{...f,config,event,oldId,newId};
}
test('signed app/content contexts deduplicate identical delivery IDs independently and wake only relevant jobs',async t=>{
 const f=await prepared(t),handler=createHandler({db:f.db,config:f.config,publisher:{}});
 assert.equal((await handler(f.event('content'))).status,200);
 let rows=(await f.db.query('SELECT submission_id,available_at<now() AS due FROM publication_jobs ORDER BY submission_id')).rows;
 assert.equal(rows.find(r=>r.submission_id===f.newId).due,true);assert.equal(rows.find(r=>r.submission_id===f.oldId).due,false);
 assert.equal((await handler(f.event('legacy'))).status,200);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,2);
 assert.equal((await (await handler(f.event('content'))).json()).duplicate,true);
 assert.equal((await (await handler(f.event('legacy'))).json()).duplicate,true);
});
test('wrong-context signed identity fails before deduplication, including same-name repository substitution',async t=>{
 const f=await prepared(t),handler=createHandler({db:f.db,config:f.config,publisher:{}});
 for(const override of [{repository:{id:999,private:true,full_name:'pvme-wiki/guides'}},{installation:{id:12345}},{repository:{id:202,private:false,full_name:'pvme-wiki/guides'}},{repository:{id:101,private:true,full_name:'example/private-guides'},installation:{id:12345}}]) assert.equal((await handler(f.event('content','synthetic-wrong-context-123',override))).status,403);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,0);
});
test('new scoped wake failure rolls back delivery and permits the same event to retry atomically',async t=>{
 const f=await prepared(t);let deny=true;
 const db={...f.db,transaction:work=>f.db.transaction(q=>work({query:async(sql,params)=>{const result=await q.query(sql,params);if(deny&&/^UPDATE publication_jobs j/.test(sql)){deny=false;throw Error('synthetic atomic wake failure');}return result;}}))};
 const handler=createHandler({db,config:f.config,publisher:{}});
 assert.equal((await handler(f.event('content'))).status,503);
 assert.equal((await f.db.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,0);
 assert.equal((await handler(f.event('content'))).status,200);
 assert.equal((await (await handler(f.event('content'))).json()).duplicate,true);
});
