import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createGuideReadTokenProvider } from '../guide-store-read-auth.mjs';
const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
const content={id:2,owner:'private-org',repo:'guides',base:'main'},app={id:1,owner:'personal',repo:'app',base:'main'};
const env={GUIDE_STORE_REPOSITORY_ID:'2',GUIDE_STORE_OWNER:'private-org',GUIDE_STORE_REPO:'guides',GUIDE_STORE_BASE_BRANCH:'main',GITHUB_REPOSITORY_ID:'1',GITHUB_OWNER:'personal',GITHUB_REPO:'app',GITHUB_BASE_BRANCH:'main',GUIDE_STORE_READ_APP_ID:'20',GUIDE_STORE_READ_INSTALLATION_ID:'21',GUIDE_STORE_READ_PRIVATE_KEY:privateKey,GUIDE_STORE_APP_READ_APP_ID:'30',GUIDE_STORE_APP_READ_INSTALLATION_ID:'31',GUIDE_STORE_APP_READ_PRIVATE_KEY:privateKey};
function mock({installationOverride={},tokenOverride={}}={}) {
 let clock=Date.parse('2026-11-13T12:00:00Z');const calls=[];
 const fetchImpl=async(url,opts)=>{calls.push({url,opts});const isContent=url.includes('/21'),repository=isContent?content:app;
  const value=opts.method==='POST'?{token:'private-token-'+calls.length,expires_at:new Date(clock+3600000).toISOString(),permissions:{contents:'read',pull_requests:'read',metadata:'read'},repository_selection:'selected',repositories:[{id:repository.id,private:true,full_name:repository.owner+'/'+repository.repo}],...tokenOverride}:{id:isContent?21:31,app_id:isContent?20:30,account:{login:repository.owner},repository_selection:'selected',permissions:{contents:'read',pull_requests:'read',metadata:'read'},suspended_at:null,...installationOverride};
  return new Response(JSON.stringify(value),{status:200});};
 return{get:createGuideReadTokenProvider(env,{fetchImpl,now:()=>clock}),calls,advance:ms=>clock+=ms};
}
test('read credentials are minted per exact private repository, cached separately and renewed',async()=>{
 const f=mock();const first=await f.get({repository:content});assert.equal(await f.get({repository:content}),first);assert.equal(f.calls.length,2);
 assert.notEqual(await f.get({repository:app}),first);assert.equal(f.calls.length,4);
 for(const call of f.calls.filter(call=>call.opts.method==='POST')) assert.deepEqual(JSON.parse(call.opts.body).permissions,{contents:'read',pull_requests:'read'});
 assert.deepEqual(JSON.parse(f.calls[1].opts.body).repository_ids,[2]);assert.deepEqual(JSON.parse(f.calls[3].opts.body).repository_ids,[1]);
 f.advance(3550000);assert.notEqual(await f.get({repository:content}),first);assert.equal(f.calls.length,6);
});
test('unknown repositories and write requests fail before sending credentials',async()=>{
 const f=mock();await assert.rejects(f.get({repository:{...content,id:3}}),/Unknown/);await assert.rejects(f.get({repository:content,permissions:{contents:'write'}}),/write/);assert.equal(f.calls.length,0);
});
test('overbroad, wrong owner, suspended or wrong installation identities cannot mint a token',async()=>{
 for(const installationOverride of [{repository_selection:'all'},{permissions:{contents:'write',pull_requests:'read'}},{account:{login:'wrong'}},{suspended_at:'2026-01-01'},{id:999},{app_id:999}]) {
 const f=mock({installationOverride});await assert.rejects(f.get({repository:content}),/installation/);assert.equal(f.calls.length,1);
 }
});
test('token substitution, public repositories and overbroad access fail without leaking provider credentials',async()=>{
 for(const tokenOverride of [{permissions:{contents:'write',pull_requests:'read'}},{repositories:[{id:2,private:false,full_name:'private-org/guides'}]},{repositories:[{id:2,private:true,full_name:'private-org/guides'},{id:1,private:true,full_name:'personal/app'}]},{repository_selection:'all'}]) {
 const f=mock({tokenOverride});await assert.rejects(f.get({repository:content}),e=>!e.message.includes('private-token')&&/restricted/.test(e.message));
 }
});
