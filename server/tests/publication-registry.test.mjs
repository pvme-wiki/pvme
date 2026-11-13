import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationTargetDescriptor } from '../publication-targets.mjs';
import { createPublicationRegistry, publicationRegistryConfig } from '../publication-registry.mjs';
const config={github:{id:101,owner:'personal',repo:'app',base:'main',installationId:'11'},guideStore:{stage:'active',origin:'guides-v1',pinPath:'content/guide-store.json',app:{id:101,owner:'personal',repo:'app',base:'main',installationId:'11'},content:{id:202,owner:'private-org',repo:'guides',base:'main',installationId:'22'}}};
const legacyProvider={ensurePullRequest(){throw Error('Only explicit caller can execute publication');},reconcile(){}};
const guideProvider={ensurePullRequest(){throw Error('Only explicit caller can execute publication');},reconcile(){}};
test('the trusted registry keeps a legacy default and routes frozen targets without reinterpreting PR numbers',()=>{
 const configured={...config,...publicationRegistryConfig(config)},registry=createPublicationRegistry({},configured,{legacyProvider,guideProvider});
 const [legacy,content]=configured.publicationTargets.map(publicationTargetDescriptor);
 assert.equal(configured.defaultPublicationTarget.pipeline,'legacy-v1');
 assert.equal(registry.resolve(legacy).provider,legacyProvider);assert.equal(registry.resolve(content).provider,guideProvider);
 assert.throws(()=>registry.resolve({...legacy,installationId:'999'}),e=>e.code==='publication_target_unknown');
 assert.throws(()=>registry.resolve({...content,repository:{...content.repository,id:'101'}}),e=>e.code==='publication_target_unknown');
});
test('shadow registry rejects new-route execution while continuing original publications',()=>{
 const staged={...config,guideStore:{...config.guideStore,stage:'shadow'}};const configured={...staged,...publicationRegistryConfig(staged)},registry=createPublicationRegistry({},configured,{legacyProvider,guideProvider});
 assert.equal(registry.resolve(configured.defaultPublicationTarget).provider,legacyProvider);
 assert.throws(()=>registry.resolve(publicationTargetDescriptor(configured.publicationTargets[1])),e=>e.code==='publication_not_activated'&&e.retryable);
 assert.deepEqual(publicationRegistryConfig({github:{id:101,owner:'personal',repo:'app'}}),{publicationTargets:undefined,defaultPublicationTarget:undefined});
});

test('an explicit compatibility switch permits legacy-only routing before org activation',()=>{
 const compatibility={github:config.github,publicationRoutingEnabled:true};const result=publicationRegistryConfig(compatibility);
 assert.equal(result.publicationTargets.length,1);assert.equal(result.defaultPublicationTarget.pipeline,'legacy-v1');
});
