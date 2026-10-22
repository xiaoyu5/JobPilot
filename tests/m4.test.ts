import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,rm,symlink,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store,listOutcomes,updateOutcome,conversionStats} from '@jobpilot/store';
import {OutcomeUpdate,type WorkerStatus,type ConversationSnapshot} from '@jobpilot/contracts';
import {DataService,applyPendingDataOperation,recoverPendingData} from '../packages/worker/src/data.js';
import {Application} from '../packages/worker/src/application.js';
import {prepare} from './m2-fixtures.js';
import {recruiterHistory} from '../packages/core/src/recruiter-identity.js';
import {SendingService,type SendTransport} from '../packages/core/src/sending.js';
import {ChattingService} from '../packages/core/src/chatting.js';
import {MatchingService} from '@jobpilot/core';
import {demoJobs} from '../fixtures/boss/demo-jobs.js';
const config={baseUrl:'http://localhost:1/v1',model:'anonymous',apiKey:'not-in-database',timeoutMs:1000,allowLan:false};
const status=():WorkerStatus=>({milestone:'M4',pid:1,node:process.versions.node,arch:process.arch,uptimeSeconds:1,mode:'preview',autoModeConsent:false,sendingAvailable:true,browser:{open:false,profilePath:'/private/profile-path'},llm:{configured:true,sessionReady:true,envPath:'/private/environment-path',hasApiKey:true,error:null}});
function sent(store:Store,index:number,state='SENT_CONFIRMED',units=1,confirmed=units,source:'boss'|'demo'='boss',createdAt=new Date().toISOString()){
  const base=demoJobs()[0],job={...base,id:`${source}:outcome_${index}`,platformJobId:`outcome_${index}`,recruiterId:`anonymous_hr_${index}`,source};store.upsertJob(job);
  const draft=randomUUID(),id=randomUUID(),run=store.createRun(source);
  store.db.prepare('INSERT INTO greeting_drafts(id,job_id,content,fact_ids_json,resume_version,audit_status,created_at) VALUES(?,?,?,?,?,?,?)').run(draft,job.id,'匿名事实回复','[]',1,'PASS',createdAt);
  store.db.prepare('INSERT INTO send_outbox(id,job_id,recruiter_id,idem_key,draft_id,state,run_id,created_at,message_units,confirmed_units,phase,default_phase) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,job.id,job.recruiterId,id,draft,state,run.id,createdAt,units,confirmed,state==='SENT_CONFIRMED'?'CONFIRMED':'CLICK_DISPATCHED',units===2&&confirmed?'CONFIRMED':'NOT_APPLICABLE');store.finishRun(run.id,'COMPLETED');return {job,id,run};
}
test('M4 outcomes use confirmed-contact cohorts, distinguish messages and external marks, and reject stale or inconsistent updates',async()=>{
  const dir=await mkdtemp('/tmp/jp-outcome-'),store=new Store(dir);try{
    assert.equal(conversionStats(store.db,{source:'boss',days:0}).replyRate,null);
    const a=sent(store,0,'SENT_CONFIRMED',2),b=sent(store,1,'MANUALLY_CONFIRMED'),c=sent(store,2,'NEEDS_VERIFY',2,1),unknown=sent(store,3,'NEEDS_VERIFY',2,0),demo=sent(store,4,'SENT_CONFIRMED',1,1,'demo');
    const external={...demoJobs()[0],id:'boss:external_mark',platformJobId:'external_mark',source:'boss' as const};store.upsertJob(external);
    for(const [jobId,rejected,interview] of [[a.job.id,false,true],[b.job.id,true,false],[external.id,false,false]] as const)updateOutcome(store.db,OutcomeUpdate.parse({jobId,expectedVersion:0,replied:true,rejected,interview,note:'联系 13800138000 / private@example.com'}));
    const value=conversionStats(store.db,{source:'boss',days:0});assert.equal(value.confirmedContacts,3);assert.equal(value.confirmedMessages,4);assert.equal(value.pageConfirmedContacts,2);assert.equal(value.manuallyConfirmedContacts,1);assert.equal(value.partialContacts,1);assert.equal(value.replied,2);assert.equal(value.rejected,1);assert.equal(value.interviews,1);assert.equal(value.replyRate,2/3);assert.equal(value.externallyMarked,1);assert.equal(value.needsVerify,2);
    assert.equal(conversionStats(store.db,{source:'demo',days:0}).confirmedContacts,1);
    assert.throws(()=>updateOutcome(store.db,OutcomeUpdate.parse({jobId:a.job.id,expectedVersion:0,replied:true,rejected:false,interview:false})),{code:'VERSION_CONFLICT'});
    assert(!OutcomeUpdate.safeParse({jobId:a.job.id,expectedVersion:1,replied:false,rejected:true,interview:false}).success);
    const rows=listOutcomes(store.db,{source:'boss',query:'',limit:20,offset:0});assert.equal(rows.total,5);assert(rows.items.find(row=>row.jobId===a.job.id)!.note.includes('[PHONE]'));assert(!JSON.stringify(rows).includes('private@example.com'));
    store.db.prepare('UPDATE send_outbox SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',c.id);assert.equal(conversionStats(store.db,{source:'boss',days:7}).confirmedContacts,2);
    assert.equal(recruiterHistory(store,[b.job.recruiterId!]).rejected,true);updateOutcome(store.db,OutcomeUpdate.parse({jobId:b.job.id,expectedVersion:1,replied:false,rejected:false,interview:false}));assert.equal(recruiterHistory(store,[b.job.recruiterId!]).rejected,true,'editing statistics must not revoke a refusal lock');assert.equal(recruiterHistory(store,[a.job.recruiterId!]).rejected,false);assert(unknown.id&&demo.id);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('AT16 diagnostic allowlist never exports secrets, contact data, free text, paths, URLs or unexpected metadata, but preserves trace IDs',async()=>{
  const dir=await mkdtemp('/tmp/jp-diagnostics-'),store=new Store(dir);try{
    prepare(store,config);const run=store.createRun('boss'),trace=randomUUID(),secret='SECRET_API_KEY_COOKIE_TOKEN';
    store.event(run.id,'RUN_STARTED',`${secret} Cookie=sid=opaque Authorization: Bearer anything 13800138000 private@example.com`,trace);
    store.db.prepare('INSERT INTO run_events(run_id,trace_id,event_type,message,created_at) VALUES(?,?,?,?,?)').run(run.id,secret,secret,secret,secret);
    store.db.prepare('UPDATE runs SET error_code=?,finished_at=? WHERE id=?').run(secret,secret,run.id);
    const service=new DataService(store,dir,status),result=await service.exportDiagnostics(run.id),bytes=await readFile(result.path,'utf8');
    for(const forbidden of [secret,'13800138000','private@example.com','opaque','anything','not-in-database','Welgoo','/private/profile-path','/private/environment-path',config.baseUrl])assert(!bytes.includes(forbidden),forbidden);
    const report=JSON.parse(bytes);assert.equal(report.runs[0].events.find((event:any)=>event.type==='RUN_STARTED').traceId,trace);assert.equal(report.runs[0].errorCode,'REDACTED');assert.equal(report.runs[0].finishedAt,null);assert.equal((await stat(result.path)).mode&0o777,0o600);
    const other=await mkdtemp('/tmp/jp-export-link-');try{await rm(`${dir}/exports`,{recursive:true});await symlink(other,`${dir}/exports`);await assert.rejects(service.exportDiagnostics(),{code:'DATA_PATH_INVALID'});assert.deepEqual(await readdir(other),[]);}finally{await rm(other,{recursive:true,force:true});}
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('backup/restore excludes browser and env, disables permissions, and preserves newer first-contact, reply and refusal locks across aliases',async()=>{
  const dir=await mkdtemp('/tmp/jp-recovery-');let store:Store|undefined=new Store(dir);try{
    prepare(store,config);await writeFile(`${dir}/.env`,'OPENAI_API_KEY=private-key-not-backed-up');await mkdir(`${dir}/chrome-profile`);await writeFile(`${dir}/chrome-profile/fixture-cookie`,'private-cookie-not-backed-up');
    const data=new DataService(store,dir,status),backup=await data.backup();assert.equal((await stat(backup.path)).mode&0o777,0o600);const contents=await readFile(backup.path);assert(!contents.includes(Buffer.from('private-key-not-backed-up')));assert(!contents.includes(Buffer.from('private-cookie-not-backed-up')));
    const sentAfterBackup=sent(store,10),run=store.createRun('boss');store.finishRun(run.id,'COMPLETED');
    const conversation:ConversationSnapshot={id:'boss-chat:uid_new',recruiterId:'uid_new',recruiterAliases:['uid_new','opaque_new~~',sentAfterBackup.job.recruiterId!],jobId:null,name:'匿名招聘人',company:'匿名公司',url:'https://www.zhipin.com/web/geek/chat',identityBound:true,historyComplete:true,messages:[{id:'refusal',direction:'incoming',text:'暂不考虑，谢谢',confirmed:true}],capturedAt:new Date().toISOString()};
    store.db.prepare('INSERT INTO chat_conversations(id,recruiter_id,name,company,state,reason,snapshot_json,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(conversation.id,conversation.recruiterId,conversation.name,conversation.company,'REJECTED','匿名拒绝',JSON.stringify(conversation),new Date().toISOString());
    store.db.prepare("INSERT INTO chat_outbox(id,run_id,conversation_id,recruiter_id,inbound_id,content,context_hash,state,created_at) VALUES(?,?,?,?,?,?,?,'SENT_CONFIRMED',?)").run(randomUUID(),run.id,'boss-chat:reply_uid','reply_uid','inbound_old','匿名回复','context',new Date().toISOString());
    store.updateConfig({bossReadOnlyConsent:true});store.setSetting('sendPolicy',{liveEnabled:true,confirmed:true,version:2});
    const plan=await data.prepareRestore(backup.path);assert.equal(plan.counts.firstContactIntents,0);await data.commitRestore(plan.id);store.close();store=undefined;
    await applyPendingDataOperation(dir);store=new Store(dir);assert.equal(store.config().bossReadOnlyConsent,false);assert.equal(store.getSetting<any>('sendPolicy')?.liveEnabled??false,false);assert.equal(store.getSetting<any>('sendPolicy')?.confirmed??false,false);assert.equal(store.listJobs({limit:50,offset:0}).total,1);assert.equal(store.resume().facts.length,2);
    assert.equal(store.db.prepare("SELECT count(*) n FROM contact_locks WHERE kind='initial'").get()!.n,3);for(const id of ['uid_new','opaque_new~~',sentAfterBackup.job.recruiterId!])assert.equal(recruiterHistory(store,[id]).rejected,true);
    assert.equal(await readFile(`${dir}/.env`,'utf8'),'OPENAI_API_KEY=private-key-not-backed-up');assert.equal(await readFile(`${dir}/chrome-profile/fixture-cookie`,'utf8'),'private-cookie-not-backed-up');
    store.updateConfig({bossReadOnlyConsent:true});const sender=new SendingService(store,new MatchingService(store,()=>config),{} as SendTransport,async()=>false);
    const chat=new ChattingService(store,sender,{readConversation:async()=>({...conversation,id:'boss-chat:reply_uid',recruiterId:'reply_uid',recruiterAliases:['reply_uid'],messages:[{id:'inbound_old',direction:'incoming',text:'做过地图项目吗？',confirmed:true}]}),prepareReply:async()=>{throw new Error('no write');},submitReply:async()=>{throw new Error('no send');},verifyReply:async()=>({state:'UNKNOWN',message:'unused'})},()=>config);
    try{assert.equal((await chat.scan()).state,'WAITING');}finally{await chat.close();await sender.close();}
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
test('restore validates exact schema, integrity, source type and confirmation lifetime without changing current data',async()=>{
  const dir=await mkdtemp('/tmp/jp-restore-invalid-'),store=new Store(dir);try{
    prepare(store,config);let now=Date.now();const service=new DataService(store,dir,status,()=>now),backup=await service.backup(),plan=await service.prepareRestore(backup.path);now+=300001;await assert.rejects(service.commitRestore(plan.id),{code:'CONFIRMATION_EXPIRED'});
    const hostile=`${dir}/hostile.sqlite`;const db=new DatabaseSync(hostile);db.exec("PRAGMA user_version=5; CREATE TABLE jobs(id TEXT); CREATE TRIGGER dangerous AFTER INSERT ON jobs BEGIN DELETE FROM jobs; END;");db.close();await assert.rejects(service.prepareRestore(hostile),{code:'BACKUP_SCHEMA_INVALID'});
    await symlink(backup.path,`${dir}/linked.sqlite`);await assert.rejects(service.prepareRestore(`${dir}/linked.sqlite`),{code:'BACKUP_INVALID'});assert.equal(store.resume().facts.length,2);assert.equal(await service.pending(),null);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('a changed queued restore is cancelled at startup while a healthy current database remains usable',async()=>{
  const dir=await mkdtemp('/tmp/jp-recovery-fail-');let store:Store|undefined=new Store(dir);try{
    prepare(store,config);const data=new DataService(store,dir,status),backup=await data.backup(),plan=await data.prepareRestore(backup.path);await data.commitRestore(plan.id);store.close();store=undefined;
    await writeFile(`${dir}/recovery/${plan.id}.sqlite`,'changed after confirmation');const result=await recoverPendingData(dir);assert.equal(result?.code,'BACKUP_CHANGED');store=new Store(dir);assert.equal(store.resume().facts.length,2);assert.equal(await new DataService(store,dir,status).pending(),null);
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
test('cleanup previews exact scope, protects queued/contacted/marked jobs and never removes contact locks',async()=>{
  const dir=await mkdtemp('/tmp/jp-cleanup-'),store=new Store(dir);try{
    const base=prepare(store,config),contacted=sent(store,20);const old='2000-01-01T00:00:00.000Z';store.db.prepare('UPDATE jobs SET fetched_at=?').run(old);
    const protectedJob={...base,id:'demo:marked',platformJobId:'marked'};store.upsertJob({...protectedJob,fetchedAt:old});updateOutcome(store.db,OutcomeUpdate.parse({jobId:protectedJob.id,expectedVersion:0,replied:true,rejected:false,interview:false}));
    const queued={...base,id:'demo:queued',platformJobId:'queued',fetchedAt:old},platform={...base,id:'demo:platform_contact',platformJobId:'platform_contact',fetchedAt:old,alreadyContacted:true};store.upsertJob(queued);store.upsertJob(platform);const draft=randomUUID();store.db.prepare('INSERT INTO greeting_drafts(id,job_id,content,fact_ids_json,resume_version,audit_status,created_at) VALUES(?,?,?,?,?,?,?)').run(draft,queued.id,'匿名草稿','[]',1,'PASS',old);store.db.prepare("INSERT INTO review_queue(id,job_id,draft_id,state,created_at) VALUES(?,?,?,'PENDING',?)").run(randomUUID(),queued.id,draft,old);
    const service=new DataService(store,dir,status),plan=service.previewCleanup('demo',new Date().toISOString());assert.equal(plan.count,1);assert.equal(service.commitCleanup(plan.id).removed,1);for(const id of [contacted.job.id,protectedJob.id,queued.id,platform.id])assert(store.getJob(id));assert.equal(store.resume().facts.length,2);
    const stale=service.previewCleanup('boss',new Date().toISOString());const extra={...base,id:'boss:extra',platformJobId:'extra',source:'boss' as const,fetchedAt:old};store.upsertJob(extra);assert.throws(()=>service.commitCleanup(stale.id),{code:'CONTEXT_CHANGED'});
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('GUI authority is required for data mutation/export and pending reset blocks further work; reset removes only owned local data',async()=>{
  const dir=await mkdtemp('/tmp/jp-reset-'),outside=await mkdtemp('/tmp/jp-outside-');let app:Application|undefined=new Application(dir);try{
    const signal=new AbortController().signal;
    for(const action of ['diagnostics.export','data.backup','data.restore.prepare','data.restore.commit','data.cleanup.preview','data.cleanup.commit','data.retention.save','data.reset','outcomes.update'] as const)await assert.rejects(app.dispatch(action,{},signal),{code:'GUI_AUTH_REQUIRED'});
    prepare(app.store,config);await writeFile(`${dir}/.env`,'private');await writeFile(`${dir}/.env.local`,'private-local');app.store.updateConfig({llmEnvPath:`${dir}/.env.local`});await writeFile(`${outside}/original-resume.txt`,'keep');await writeFile(`${outside}/.env`,'external-key-kept');await mkdir(`${dir}/chrome-profile`);await writeFile(`${dir}/chrome-profile/cookie`,'private');await mkdir(`${dir}/backups`);await writeFile(`${dir}/backups/private.sqlite`,'private');
    await app.dispatch('data.reset',{confirmation:'清除 JobPilot 本机数据'},signal,true);await assert.rejects(app.dispatch('demo.load',{},signal),{code:'RESTART_REQUIRED'});
    await app.close();app=undefined;await applyPendingDataOperation(dir);assert.equal(await readFile(`${outside}/original-resume.txt`,'utf8'),'keep');assert.equal(await readFile(`${outside}/.env`,'utf8'),'external-key-kept');for(const name of ['.env','.env.local','chrome-profile','backups','jobpilot.sqlite','data-operation.json'])await assert.rejects(stat(`${dir}/${name}`),{code:'ENOENT'});
    const empty=new Store(dir);try{assert.equal(empty.resume().facts.length,0);assert.equal(empty.listJobs({limit:1,offset:0}).total,0);}finally{empty.close();}
  }finally{await app?.close();await rm(dir,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('v4 to v5 migration saves a private consistent backup and keeps jobs, facts, queue and conversation data',async()=>{
  const dir=await mkdtemp('/tmp/jp-m4-migration-');let store:Store|undefined=new Store(dir);try{
    prepare(store,config);const facts=store.resume(),jobs=store.listJobs({limit:50,offset:0});store.db.exec('DROP INDEX contact_locks_recruiter; DROP TABLE contact_locks; DROP TABLE job_outcomes; PRAGMA user_version=4;');store.close();store=new Store(dir);
    assert.deepEqual(store.resume(),facts);assert.deepEqual(store.listJobs({limit:50,offset:0}),jobs);assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version,5);assert.equal((await stat(`${dir}/jobpilot.pre-m4.sqlite`)).mode&0o777,0o600);
    const backup=new DatabaseSync(`${dir}/jobpilot.pre-m4.sqlite`,{readOnly:true});try{assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version,4);}finally{backup.close();}
  }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
