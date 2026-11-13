import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { loadGuideStoreConfig } from '../guide-store-config.mjs';
const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
const legacy={id:1,owner:'personal',repo:'app',base:'main',installationId:'11'};
const env={GUIDE_STORE_STAGE:'shadow',GUIDE_STORE_REPOSITORY_ID:'2',GUIDE_STORE_OWNER:'private-org',GUIDE_STORE_REPO:'guides',GUIDE_STORE_BASE_BRANCH:'main',GUIDE_STORE_APP_ID:'21',GUIDE_STORE_INSTALLATION_ID:'22',GUIDE_STORE_APP_PRIVATE_KEY:privateKey,GUIDE_STORE_WEBHOOK_SECRET:'x'.repeat(40),GITHUB_REPOSITORY_ID:'1'};
test('migration remains entirely optional and never retargets the legacy publisher',()=>{
 assert.deepEqual(loadGuideStoreConfig({},legacy),{config:null,errors:[]});
 const result=loadGuideStoreConfig(env,legacy);assert.deepEqual(result.errors,[]);assert.equal(result.config.stage,'shadow');assert.equal(result.config.app.owner,'personal');assert.equal(result.config.content.id,2);assert.equal(legacy.owner,'personal');
});
test('partial, wrong-identity and malformed publisher configurations cannot activate',()=>{
 for(const overrides of [{GUIDE_STORE_STAGE:'latest'},{GUIDE_STORE_REPOSITORY_ID:'0'},{GUIDE_STORE_APP_PRIVATE_KEY:'secret-invalid'},{GUIDE_STORE_OWNER:'../org'},{GUIDE_STORE_OWNER:'personal',GUIDE_STORE_REPO:'app'},{GUIDE_STORE_BASE_BRANCH:'main//other'}]) {const result=loadGuideStoreConfig({...env,...overrides},legacy);assert.equal(result.config,null);assert.ok(result.errors.length);assert.ok(!JSON.stringify(result.errors).includes('secret-invalid'));}
 assert.equal(loadGuideStoreConfig({GUIDE_STORE_STAGE:'active'},legacy).config,null);
});
