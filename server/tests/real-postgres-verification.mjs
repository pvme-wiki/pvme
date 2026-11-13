// Invoked only by scripts/verify-local-postgres.mjs against its own cluster.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { randomUUID, randomBytes, createHash, createHmac } from 'node:crypto';
import { createDatabase, postgresOptions } from '../db.mjs';
import { migrate, seed } from '../manage.mjs';
import { createService } from '../service.mjs';
import { createJobRunner } from '../jobs.mjs';
import { createHandler } from '../http.mjs';
import { createPinController, handoffGuidePublication } from '../publication-targets.mjs';
import { approvedFiles } from '../github.mjs';
import { documentHash } from '../core.mjs';
import { verifyPublicationGate } from '../publication-gate.mjs';

const untrusted = process.argv[2] === '--untrusted';
const configFile = process.argv[untrusted ? 3 : 2];
if (!configFile || !path.resolve(configFile).includes(path.sep+'.runtime'+path.sep+'postgres-selected-role-')) throw Error('Use the explicit local PostgreSQL launcher.');
const local = JSON.parse(await fs.readFile(configFile,'utf8'));
assert.equal(local.host,'localhost');
assert.ok(Number.isInteger(local.port) && local.port>0 && local.port<65536);
const connection = (role, password, database='pvme_verify') => `postgresql://${role}:${password}@localhost:${local.port}/${database}`;
if (untrusted) {
  const db = createDatabase({databaseUrl:connection('pvme_runtime',local.credentials.runtime)});
  try {
    await assert.rejects(db.query('SELECT 1'), error => ['SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(error.code));
    console.log(JSON.stringify({check:'production TLS rejects an untrusted local CA',passed:true}));
  } finally {await db.close();}
  process.exit(0);
}
const report={scope:'disposable loopback PostgreSQL; no production/provider credentials used',checks:[],startedAt:new Date().toISOString()};
const root=path.resolve(import.meta.dirname,'../..');
report.sourceFiles={};
for(const name of ['server/db.mjs','server/manage.mjs','server/migrations/001_initial.sql','server/migrations/002_publication_targets.sql','server/publication-targets.mjs','server/service.mjs','server/jobs.mjs','server/http.mjs','server/publication-webhooks.mjs','server/approval.mjs','server/publication-gate.mjs']) report.sourceFiles[name]=createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex');
const connections=[];
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function check(name,work){const start=performance.now();try{const evidence=await work();report.checks.push({name,passed:true,milliseconds:Math.round(performance.now()-start),...(evidence?{evidence}:{})});console.log(JSON.stringify({check:name,passed:true}));}catch(error){report.checks.push({name,passed:false,code:error.code||null,message:error.message});throw error;}}
const gate=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return{promise,resolve};};
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const legacy={pipeline:'legacy-v1',origin:'legacy-v1',repository:{id:'101',owner:'example',repo:'private-guides',base:'main'},installationId:'12345'};
const content={pipeline:'content-pin-v1',origin:'guides-v1',repository:{id:'202',owner:'pvme-wiki',repo:'guides',base:'main'},installationId:'67890'};
const registry=[{...legacy,appRepository:legacy.repository},{...content,appRepository:legacy.repository}];
let bootstrap,operator,runtime1,runtime2,owner,reviewer,baseline,interfaceGuide,legacyId,contentId,beforeReceipt,beforeHistory;
const historySnapshot=async db=>{
 const result={};
 for(const [table,order]of[['guide_revisions','guide_id,revision'],['draft_history','owner_id,guide_id,version'],['audit_events','created_at,id']])result[table]=(await db.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
 result.snapshots=(await db.query('SELECT id,document,baseline_document,content_hash,baseline_hash,summary,created_at FROM submissions ORDER BY id')).rows;
 return digest(result);
};
const serviceOptions={publicationEnabled:true,publicationTargets:registry,defaultPublicationTarget:legacy};
const approvedEntry=async id=>{
 const row=(await runtime1.query('SELECT * FROM submissions WHERE id=$1',[id])).rows[0];
 return{document:row.document,contentHash:row.content_hash,receipt:approvedFiles(row)[`content/reviews/${row.id}.json`]};
};
const readOnlyGate=(entries,options)=>runtime1.transaction(async q=>{
 await q.query('SET TRANSACTION READ ONLY');
 assert.equal((await q.query("SELECT current_setting('transaction_read_only') AS enabled")).rows[0].enabled,'on');
 let authorityQueries=0;
 const result=await verifyPublicationGate({query:(sql,params)=>{assert.match(sql,/^SELECT\s/);authorityQueries++;return q.query(sql,params);}},entries,options);
 assert.equal(authorityQueries,1);
 return result;
});
const gateState=async()=>digest({history:await historySnapshot(runtime2),guides:(await runtime2.query('SELECT * FROM guides ORDER BY id')).rows,jobs:(await runtime2.query('SELECT * FROM publication_jobs ORDER BY submission_id')).rows,controllers:(await runtime2.query('SELECT * FROM publication_pin_controllers ORDER BY origin')).rows});

try{
 bootstrap=new pg.Client(postgresOptions(connection('pvme_bootstrap',local.credentials.bootstrap,'postgres')));await bootstrap.connect();
 for(const role of ['operator','runtime'])await bootstrap.query(`CREATE ROLE pvme_${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(local.credentials[role])}`);
 await bootstrap.query('CREATE DATABASE pvme_verify OWNER pvme_operator');
 await bootstrap.query('REVOKE ALL ON DATABASE pvme_verify FROM PUBLIC');
 await bootstrap.query('GRANT CONNECT ON DATABASE pvme_verify TO pvme_operator,pvme_runtime');
 operator=createDatabase({databaseUrl:connection('pvme_operator',local.credentials.operator)});connections.push(operator);
 runtime1=createDatabase({databaseUrl:connection('pvme_runtime',local.credentials.runtime)});connections.push(runtime1);
 runtime2=createDatabase({databaseUrl:connection('pvme_runtime',local.credentials.runtime)});connections.push(runtime2);
 await check('real PostgreSQL and unchanged production client negotiate verified TLS',async()=>{
  const actual=(await operator.query("SELECT version(),current_user,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl,(SELECT version FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls")).rows[0];
  assert.match(actual.version,/PostgreSQL \d+\./);assert.equal((await operator.query("SELECT current_setting('cluster_name') AS name")).rows[0].name,local.clusterName);assert.equal(actual.current_user,'pvme_operator');assert.equal(actual.ssl,true);assert.match(actual.tls,/^TLSv1\.[23]$/);
  assert.equal(postgresOptions(connection('pvme_runtime',local.credentials.runtime)+'?sslmode=disable').ssl.rejectUnauthorized,true);
  return{server:actual.version,tls:actual.tls};
 });
 await check('operator installs v1 and runtime uses only the documented baseline grants',async()=>{
  await operator.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  await operator.query(await fs.readFile(path.join(root,'server/migrations/001_initial.sql'),'utf8'));
  await seed(operator,{guideIds:['arch-glacor-basic','interface-guide']});
  await operator.query(`GRANT USAGE ON SCHEMA public TO pvme_runtime;
   GRANT SELECT ON schema_migrations,users,oauth_states,sessions,rate_limits,guide_revisions,guides,drafts,draft_history,submissions,audit_events,publication_jobs,webhook_deliveries TO pvme_runtime;
   GRANT INSERT ON users,oauth_states,sessions,rate_limits,guide_revisions,drafts,draft_history,submissions,audit_events,publication_jobs,webhook_deliveries TO pvme_runtime;
   GRANT UPDATE(display_name,role,version) ON users TO pvme_runtime;
   GRANT UPDATE(revision) ON guides TO pvme_runtime;
   GRANT UPDATE ON rate_limits,drafts,publication_jobs TO pvme_runtime;
   GRANT UPDATE(status,version,reviewer_id,review_note,reviewed_at) ON submissions TO pvme_runtime;
   GRANT DELETE ON oauth_states,sessions,rate_limits,webhook_deliveries TO pvme_runtime;`);
  owner=randomUUID();reviewer=randomUUID();
  await operator.query("INSERT INTO users(id,discord_id,display_name,role) VALUES($1,'12345678','Local author','contributor'),($2,'87654321','Local reviewer','moderator')",[owner,reviewer]);
  const service=createService(runtime1,{publicationEnabled:true});baseline=(await service.getGuide('arch-glacor-basic')).document;interfaceGuide=(await service.getGuide('interface-guide')).document;
  const document={...structuredClone(baseline),title:'Local legacy approved title'};
  await service.saveDraft(owner,baseline.id,{document,expectedVersion:0,baseRevision:1});
  const pending=await service.submit(owner,baseline.id,{expectedVersion:1,summary:'Local PostgreSQL legacy fixture'});legacyId=pending.id;
  await service.review(reviewer,legacyId,{decision:'approve',expectedVersion:1,note:'Local independent review'});
  const row=(await operator.query('SELECT * FROM submissions WHERE id=$1',[legacyId])).rows[0];beforeReceipt=approvedFiles(row);beforeHistory=await historySnapshot(operator);
 });
 await check('real 002 migration backfills immutable destinations without changing receipt or history bytes',async()=>{
  assert.deepEqual(await migrate(operator,{legacyTarget:legacy}),{applied:true,versions:[2]});
  assert.deepEqual(await migrate(operator),{applied:false,versions:[]});
  assert.equal(await historySnapshot(operator),beforeHistory);
  const row=(await operator.query('SELECT * FROM submissions WHERE id=$1',[legacyId])).rows[0];
  assert.deepEqual(row.publication_target,legacy);assert.deepEqual(approvedFiles(row),beforeReceipt);
  await operator.query(`REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON publication_migration_settings,guide_publication_authority FROM pvme_runtime;
   GRANT SELECT ON publication_migration_settings,guide_publication_authority,publication_pin_controllers TO pvme_runtime;
   REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON publication_pin_controllers FROM pvme_runtime;
   GRANT INSERT,UPDATE ON publication_pin_controllers TO pvme_runtime;
   REVOKE UPDATE ON guides FROM pvme_runtime;
   REVOKE UPDATE(publication_target) ON guides FROM pvme_runtime;
   GRANT UPDATE(revision,publication_pin) ON guides TO pvme_runtime;`);
 });
 await check('real runtime read-only build gate verifies legacy approval inventory and rejects an altered private receipt',async()=>{
  const before=await gateState(),entry=await approvedEntry(legacyId);
  const options={expectedBaselines:new Map([[baseline.id,baseline],[interfaceGuide.id,interfaceGuide]])};
  assert.deepEqual(await readOnlyGate([entry],options),{verifiedCount:1,submissionIds:[legacyId]});
  const altered=structuredClone(entry);altered.receipt.reviewNote+=' changed after approval';
  await assert.rejects(readOnlyGate([altered],options),error=>error.code==='approval_content_mismatch');
  assert.equal(await gateState(),before);
  return{verifiedCount:1,authorityStatementCount:1,transactionReadOnly:true,historyAndJobsUnchanged:true};
 });
 await check('runtime has no ownership, role escalation, DDL or authority/settings write privileges',async()=>{
  const role=(await runtime1.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.ok(Object.values(role).every(value=>value===false));
  assert.equal((await runtime1.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tableowner=current_user")).rows[0].n,0);
  assert.equal((await runtime1.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0].allowed,false);
  assert.equal((await runtime1.query("SELECT pg_has_role(current_user,'pvme_operator','MEMBER') AS allowed")).rows[0].allowed,false);
  for(const sql of ["INSERT INTO publication_migration_settings(singleton,legacy_target) VALUES(true,\'{}\'::jsonb)","UPDATE publication_migration_settings SET legacy_target=legacy_target","DELETE FROM publication_migration_settings","INSERT INTO guide_publication_authority(guide_id,target,canonical_revision,content_hash) SELECT id,publication_target,revision,repeat(\'0\',64) FROM guides LIMIT 1","UPDATE guide_publication_authority SET version=version","DELETE FROM guide_publication_authority","UPDATE guides SET publication_target=publication_target","ALTER TABLE submissions DISABLE TRIGGER ALL"])
   await assert.rejects(runtime1.query(sql),error=>error.code==='42501');
  const triggers=(await operator.query("SELECT proname,prosecdef FROM pg_proc WHERE proname IN ('sync_guide_publication_authority','protect_guide_publication_authority','sync_publication_pin_controller','bind_submission_publication_target','protect_submission_publication_target') ORDER BY proname")).rows;
  assert.equal(triggers.length,5);assert.ok(triggers.every(row=>row.prosecdef===false));
  return{role:'pvme_runtime',ownedTables:0,invokerTriggerFunctions:triggers.length};
 });
 await check('two independent runtime clients produce one draft CAS winner and preserve the losing edit',async()=>{
  const pids=await Promise.all([runtime1.query('SELECT pg_backend_pid() AS pid'),runtime2.query('SELECT pg_backend_pid() AS pid')]);assert.notEqual(pids[0].rows[0].pid,pids[1].rows[0].pid);
  const first=createService(runtime1,serviceOptions),second=createService(runtime2,serviceOptions);
  const candidates=['Client one draft','Client two draft'].map(title=>({...structuredClone(interfaceGuide),title}));
  const results=await Promise.allSettled([first.saveDraft(owner,interfaceGuide.id,{document:candidates[0],expectedVersion:0,baseRevision:1}),second.saveDraft(owner,interfaceGuide.id,{document:candidates[1],expectedVersion:0,baseRevision:1})]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(results.filter(value=>value.status==='rejected'&&value.reason.code==='revision_conflict').length,1);
  const saved=await first.getDraft(owner,interfaceGuide.id);assert.equal(saved.version,1);assert.ok(candidates.some(document=>documentHash(document)===documentHash(saved.document)));
  return{independentBackendPids:pids.map(value=>value.rows[0].pid),successfulSaves:1,conflicts:1};
 });
 await check('operator handoff and runtime source creation exercise real invoker triggers without changing source history',async()=>{
  const oldVersion=createService(runtime1,{publicationEnabled:true});
  const oldSubmission=await oldVersion.submit(owner,interfaceGuide.id,{expectedVersion:1,summary:'Old-version INSERT must bind the immutable legacy tuple'});
  assert.deepEqual((await operator.query('SELECT publication_target FROM submissions WHERE id=$1',[oldSubmission.id])).rows[0].publication_target,legacy);
  await createService(runtime1,serviceOptions).review(reviewer,oldSubmission.id,{decision:'reject',expectedVersion:1,note:'Resolve local legacy fixture before handoff'});
  await handoffGuidePublication(operator,{guideId:interfaceGuide.id,target:content,expectedRevision:1,expectedHash:documentHash(interfaceGuide),contentCommit:'a'.repeat(40),verifyContent:async proof=>proof.expectedRevision===1&&proof.contentHash===documentHash(interfaceGuide),reason:'Local-only verified fixture proof; no remote authority activated'});
  const service=createService(runtime1,serviceOptions);
  await service.saveDraft(owner,interfaceGuide.id,{document:{...structuredClone(interfaceGuide),title:'A new content-target draft'},expectedVersion:1,baseRevision:1});
  const pending=await service.submit(owner,interfaceGuide.id,{expectedVersion:2,summary:'Local content target fixture'});contentId=pending.id;
  await service.review(reviewer,contentId,{decision:'approve',expectedVersion:1,note:'Local target-bound independent approval'});
  const row=(await operator.query('SELECT * FROM submissions WHERE id=$1',[contentId])).rows[0];assert.deepEqual(row.publication_target,content);
  await assert.rejects(runtime1.query('UPDATE submissions SET publication_target=$2 WHERE id=$1',[contentId,JSON.stringify(legacy)]),error=>error.code==='42501');
  await assert.rejects(operator.query('UPDATE submissions SET publication_target=$2 WHERE id=$1',[contentId,JSON.stringify(legacy)]),error=>error.code==='P0001'&&/immutable/.test(error.message));
  await assert.rejects(operator.query('UPDATE draft_history SET content_hash=content_hash'),error=>error.code==='P0001');
  await assert.rejects(operator.query('UPDATE guide_revisions SET content_hash=content_hash'),error=>error.code==='P0001');
  await assert.rejects(operator.query('UPDATE audit_events SET data=data'),error=>error.code==='P0001');
  await assert.rejects(operator.query("UPDATE submissions SET document=jsonb_set(document,'{title}',to_jsonb('unreviewed'::text))"),error=>error.code==='P0001');
 });
 await check('runtime pin controller grants support atomic mirrors and reject stale/backward CAS',async()=>{
  const controller=createPinController(runtime1);
  await controller.withLease(content.origin,async lease=>{
   const initial=await lease.read();assert.equal(initial.version,0);
   const first=await lease.checkpoint({expectedVersion:0,contentCommit:'a'.repeat(40),provider:{websiteNumber:1}});assert.equal(first.version,1);
   const mirrored=(await runtime2.query('SELECT revision,publication_pin FROM guides WHERE id=$1',[interfaceGuide.id])).rows[0];assert.equal(mirrored.revision,1);assert.deepEqual(mirrored.publication_pin,{contentCommit:'a'.repeat(40),version:1});
   await assert.rejects(lease.checkpoint({expectedVersion:0,contentCommit:'b'.repeat(40),isDescendant:async()=>true}),error=>error.code==='pin_conflict');
   await assert.rejects(lease.checkpoint({expectedVersion:1,contentCommit:'0'.repeat(40),isDescendant:async()=>false}),error=>error.code==='pin_not_forward');
   await lease.checkpoint({expectedVersion:1,contentCommit:'b'.repeat(40),provider:{websiteNumber:2},isDescendant:async(base,head)=>base==='a'.repeat(40)&&head==='b'.repeat(40)});
  });
  assert.deepEqual((await runtime2.query('SELECT publication_pin FROM guides WHERE id=$1',[interfaceGuide.id])).rows[0].publication_pin,{contentCommit:'b'.repeat(40),version:2});
  await assert.rejects(runtime2.query('UPDATE guides SET publication_pin=$2 WHERE id=$1',[interfaceGuide.id,JSON.stringify({contentCommit:'a'.repeat(40),version:1})]),error=>error.code==='P0001'&&/durable controller/.test(error.message));
 });
 await check('independent controller clients serialize and fence expired late completions and releases',async()=>{
  const first=createPinController(runtime1),second=createPinController(runtime2),entered=gate(),finish=gate(),newEntered=gate(),newFinish=gate();
  const stale=first.withLease(content.origin,async lease=>{entered.resolve();await finish.promise;await assert.rejects(lease.checkpoint({expectedVersion:2,contentCommit:'c'.repeat(40),isDescendant:async()=>true}),error=>error.code==='lease_superseded');});
  await entered.promise;
  await assert.rejects(second.withLease(content.origin,async()=>{}),error=>error.code==='pin_busy');
  await operator.query("UPDATE publication_pin_controllers SET lease_until=now()-interval '1 second' WHERE origin=$1",[content.origin]);
  const fresh=second.withLease(content.origin,async lease=>{await lease.checkpoint({expectedVersion:2,contentCommit:'d'.repeat(40),provider:{websiteNumber:3},isDescendant:async()=>true});newEntered.resolve();await newFinish.promise;assert.equal((await lease.read()).contentCommit,'d'.repeat(40));});
  await newEntered.promise;finish.resolve();await stale;newFinish.resolve();await fresh;
  const row=(await runtime1.query('SELECT content_commit,lease_token FROM publication_pin_controllers WHERE origin=$1',[content.origin])).rows[0];assert.equal(row.content_commit,'d'.repeat(40));assert.equal(row.lease_token,null);
 });
 await check('real runtime read-only build gate verifies mixed authorities and current pin, with explicit mocked source proof',async()=>{
  const before=await gateState(),entries=await Promise.all([approvedEntry(legacyId),approvedEntry(contentId)]),entry=entries[1];
  const appCommit='e'.repeat(40),contentCommit='d'.repeat(40);
  const pin={schemaVersion:1,mode:'active',origin:content.origin,repository:{...content.repository,id:Number(content.repository.id)},contentCommit,manifestSha256:'f'.repeat(64),guideIds:[interfaceGuide.id]};
  const guideStore={pin,guides:new Map([[interfaceGuide.id,{document:entry.document,contentHash:entry.contentHash,baselineHash:documentHash(interfaceGuide),revision:2}]])};
  let proofCalls=0;
  // Deliberate fixture: no remote GitHub ancestry or deployment is claimed.
  const mockVerifySource=async input=>{
   proofCalls++;assert.equal(input.appCommit,appCommit);assert.deepEqual(input.pin,pin);
   assert.deepEqual(input.rows.map(row=>row.id).sort(),[legacyId,contentId].sort());
   for(const row of input.rows){const expected=entries.find(value=>value.receipt.submissionId===row.id);assert.equal(documentHash(row.document),expected.contentHash);assert.deepEqual(row.publication_target,row.id===contentId?content:legacy);assert.ok(Array.isArray(row.approval_events)&&row.approval_events.length>0);}
   return{appCommit,contentCommit,contentOrigin:content.origin};
  };
  const options={expectedBaselines:new Map([[baseline.id,baseline],[interfaceGuide.id,interfaceGuide]]),guideStore,appCommit,verifySource:mockVerifySource};
  assert.deepEqual(await readOnlyGate(entries,options),{verifiedCount:2,submissionIds:[legacyId,contentId]});assert.equal(proofCalls,1);
  const wrongPin={...guideStore,pin:{...pin,contentCommit:'b'.repeat(40)}};
  await assert.rejects(readOnlyGate(entries,{...options,guideStore:wrongPin}),error=>error.code==='content_pin_not_current');assert.equal(proofCalls,1);
  await assert.rejects(readOnlyGate(entries,{...options,verifySource:null}),error=>error.code==='publication_source_unavailable');
  await assert.rejects(readOnlyGate(entries,{...options,verifySource:async()=>false}),error=>error.code==='publication_source_unavailable');
  assert.equal(await gateState(),before);
  return{verifiedCount:2,authorityStatementCount:1,transactionReadOnly:true,sourceProof:'explicit mock, no remote ancestry verification',historyAndJobsUnchanged:true};
 });
 await check('independent job workers refuse duplicate claims and a late expired worker cannot overwrite its replacement',async()=>{
  const entered=gate(),finish=gate();
  const firstProvider={ensurePullRequest:async()=>{entered.resolve();await finish.promise;return{number:1,branchSha:'a'.repeat(40)};},reconcile:async(_row,info)=>({state:'awaiting_merge',provider:info})};
  const secondProvider={ensurePullRequest:async()=>({number:2,branchSha:'b'.repeat(40)}),reconcile:async(_row,info)=>({state:'awaiting_merge',provider:info})};
  const make=(db,provider)=>createJobRunner(db,{resolve:async target=>({target,provider})},{origin:'https://pvme.example',publicationTargets:registry});
  const first=make(runtime1,firstProvider),second=make(runtime2,secondProvider),running=first.runOne({submissionId:legacyId});
  await entered.promise;assert.equal((await second.runOne({submissionId:legacyId})).state,'idle');
  await operator.query("UPDATE publication_jobs SET lease_until=now()-interval '1 second' WHERE submission_id=$1",[legacyId]);
  assert.equal((await second.runOne({submissionId:legacyId})).state,'awaiting_merge');finish.resolve();assert.equal((await running).state,'superseded');
  const row=(await runtime2.query('SELECT state,provider FROM publication_jobs WHERE submission_id=$1',[legacyId])).rows[0];assert.equal(row.state,'awaiting_merge');assert.equal(row.provider.number,2);
 });
 await check('real PostgreSQL atomically rolls back webhook deduplication and scoped wake and permits redelivery',async()=>{
  await operator.query("UPDATE publication_jobs SET state='awaiting_merge',available_at=now()+interval '1 hour'");
  const config={configured:true,origin:'https://pvme.example',sessionSecret:randomBytes(32).toString('hex'),accessMode:'open',allowedDiscordIds:[],publicationTargets:registry,defaultPublicationTarget:legacy,
   github:{id:101,owner:'example',repo:'private-guides',installationId:'12345',webhookSecret:randomBytes(32).toString('hex'),cronSecret:randomBytes(32).toString('hex')},
   guideStore:{origin:'guides-v1',app:{id:101},content:{...content.repository,id:202,installationId:'67890',webhookSecret:randomBytes(32).toString('hex')}}};
  const delivery='local-postgres-webhook-'+randomUUID();
  const raw=Buffer.from(JSON.stringify({repository:{id:202,full_name:'pvme-wiki/guides',private:true},installation:{id:67890}}));
  const event=()=>new Request(config.origin+'/api/editor/webhooks/github',{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256',config.guideStore.content.webhookSecret).update(raw).digest('hex'),'x-github-delivery':delivery,'x-github-event':'push'},body:raw});
  let rejectWake=true;
  const wrapped={...runtime1,transaction:work=>runtime1.transaction(q=>work({query:async(sql,params)=>{const result=await q.query(sql,params);if(rejectWake&&/^UPDATE publication_jobs j/.test(sql)){rejectWake=false;throw Error('Local injected wake failure after SQL');}return result;}}))};
  const handler=createHandler({db:wrapped,config,publisher:{}});
  assert.equal((await handler(event())).status,503);
  assert.equal((await runtime2.query('SELECT count(*)::int AS n FROM webhook_deliveries')).rows[0].n,0);
  assert.equal((await runtime2.query('SELECT count(*)::int AS n FROM publication_jobs WHERE available_at<now()')).rows[0].n,0);
  assert.equal((await handler(event())).status,200);
  assert.equal((await (await handler(event())).json()).duplicate,true);
  const rows=(await runtime2.query('SELECT submission_id,available_at<now() AS due FROM publication_jobs')).rows;
  assert.equal(rows.find(row=>row.submission_id===contentId).due,true);assert.equal(rows.find(row=>row.submission_id===legacyId).due,false);
 });
 await check('original approved snapshots and receipts remain unchanged after concurrent runtime operations',async()=>{
  const original=(await operator.query('SELECT * FROM submissions WHERE id=$1',[legacyId])).rows[0];assert.deepEqual(approvedFiles(original),beforeReceipt);
  assert.equal(original.content_hash,documentHash(original.document));assert.equal(original.baseline_hash,documentHash(original.baseline_document));
  assert.equal((await operator.query("SELECT count(*)::int AS n FROM guide_revisions WHERE guide_id=$1 AND revision>1",[baseline.id])).rows[0].n,0);
  assert.equal((await operator.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,2);
 });
 report.finishedAt=new Date().toISOString();report.result='passed';
}catch(error){report.result='failed';report.error={code:error.code||null,message:error.message};console.error(JSON.stringify({result:'failed',check:report.checks.at(-1)?.name,...report.error}));process.exitCode=1;}
finally{
 await Promise.all(connections.map(db=>db.close().catch(()=>{})));await bootstrap?.end().catch(()=>{});
 await fs.writeFile(local.report,JSON.stringify(report,null,2)+'\n');
}
