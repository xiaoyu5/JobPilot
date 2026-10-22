import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '@jobpilot/store';
import {MatchingService} from '@jobpilot/core';
import {SendingService,type SendTransport} from '../packages/core/src/sending.js';
import {startWorker} from '../packages/worker/src/server.js';
import {callWorker} from '../packages/worker/src/client.js';
import {AppError,type JobRecord,type SendVerification} from '@jobpilot/contracts';
import {withModel,goodResponse,prepare} from './m2-fixtures.js';
import {seedSendQueue} from './m3-fixtures.js';
import {DatabaseSync} from 'node:sqlite';
import {ChattingService} from '../packages/core/src/chatting.js';
const signal=()=>new AbortController().signal;
const policy={liveEnabled:true,threshold:80,maxPerRun:5,maxPerDay:15,minIntervalSeconds:15,maxRunsPerDay:2,timeZone:'UTC',startTime:'00:00',endTime:'23:59',acknowledged:true as const};
async function setup(config:any,count=1){
  const dir=await mkdtemp('/tmp/jp-m3-'),store=new Store(dir),base=prepare(store,config);store.updateConfig({bossReadOnlyConsent:true});const matching=new MatchingService(store,()=>config),ids:string[]=[],jobs:JobRecord[]=[];
  for(let i=0;i<count;i++){const job={...base,id:`boss:m3_${i}`,platformJobId:`m3_${i}`,source:'boss' as const,recruiterId:`recruiter_${i}`,url:`https://www.zhipin.com/job_detail/m3_${i}.html`};store.upsertJob(job);await matching.analyze(job.id,signal());const draft=await matching.generate(job.id,'natural',signal());const item=matching.queue(job.id,draft.id);matching.review(item.queueItemId,1);ids.push(item.queueItemId);jobs.push(job);}
  let now=Date.parse('2026-10-22T10:00:00Z'),healthy=true;
  const actions:string[]=[];let inspectError:string|undefined,submitError=false,confirmed=true,onPrepare:(()=>void)|undefined,onSubmit:(()=>void)|undefined,onVerify:(()=>void)|undefined;
  const transport:SendTransport={
    inspectCommunication:async job=>{actions.push('inspect:'+job.id);if(inspectError)throw new AppError(inspectError,'fixture blocker');return {job,inspection:{jobId:job.id,recruiterId:job.recruiterId,identityBound:true,composerReady:true,canOpenPreview:false,alreadyContacted:false,message:'fixture editor',url:job.url,adapterVersion:'fixture'}};},
    prepareGreeting:async job=>{assert(store.db.prepare("SELECT id FROM send_outbox WHERE job_id=? AND state='SENDING'").get(job.id),'intent must precede page mutation');actions.push('prepare:'+job.id);onPrepare?.();},
    submitGreeting:async job=>{actions.push('submit:'+job.id);onSubmit?.();if(submitError)throw new Error('fixture network lost after click');},
    verifyGreeting:async()=>{actions.push('verify');onVerify?.();return confirmed?{state:'CONFIRMED',messageId:'server-fixture-id',message:'visible confirmation'}:{state:'UNKNOWN',message:'fixture uncertain'};},
  };
  const sender=new SendingService(store,matching,transport,async()=>healthy,()=>now);sender.savePolicy(policy,true);
  return {dir,store,matching,sender,transport,ids,jobs,actions,now:()=>now,setNow:(value:number)=>now=value,advance:(value:number)=>now+=value,setHealthy:(value:boolean)=>healthy=value,setInspectError:(value:string|undefined)=>inspectError=value,setSubmitError:(value:boolean)=>submitError=value,setConfirmed:(value:boolean)=>confirmed=value,onPrepare:(fn:()=>void)=>onPrepare=fn,onSubmit:(fn:()=>void)=>onSubmit=fn,onVerify:(fn:()=>void)=>onVerify=fn,close:async()=>{await sender.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
async function complete(sender:SendingService){await sender.active?.promise;}
async function review(sender:SendingService,ids:string[]){const plan=await sender.prepare(ids,signal());assert(plan.items.every(item=>!item.blocks.length),JSON.stringify(plan.items.map(item=>item.blocks)));return sender.commit(plan.id,true);}

test('first contact cannot bypass a recorded refusal through an opaque alias or the same visible recruiter and company',async()=>withModel(goodResponse,async config=>{
  for(const mode of ['alias','visible-name']){
    const f=await setup(config);let chat:ChattingService|undefined;try{
      const job=f.jobs[0],recruiterId='fixture_numeric_uid';
      f.store.upsertJob({...job,snapshot:JSON.stringify({recruiterName:'匿名招聘人'})});
      chat=new ChattingService(f.store,f.sender,{readConversation:async()=>({id:'boss-chat:'+recruiterId,recruiterId,recruiterAliases:mode==='alias'?[recruiterId,job.recruiterId!]:[recruiterId],jobId:null,name:'匿名招聘人',company:job.company,url:'https://www.zhipin.com/web/geek/chat',identityBound:true,historyComplete:true,messages:[{id:'refusal_message',direction:'incoming',text:'暂不考虑，谢谢',confirmed:true}],capturedAt:new Date().toISOString()}),prepareReply:async()=>{},submitReply:async()=>{},verifyReply:async()=>({state:'UNKNOWN',message:'unused'})},()=>config);
      await chat.scan();const plan=await f.sender.prepare(f.ids,signal());assert(plan.items[0].blocks.some(block=>block.code==='CONVERSATION_REJECTED'),mode);assert.throws(()=>f.sender.commit(plan.id,true),{code:'CONVERSATION_REJECTED'});assert.equal(f.sender.outbox().total,0);assert.equal(f.actions.length,0);
    }finally{await chat?.close();await f.close();}
  }
}));

test('AT08: GUI consent, context-bound confirmation and persisted SEND_INTENT precede one verified send',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config);try{
    assert.throws(()=>f.sender.savePolicy(policy,false),{code:'GUI_AUTH_REQUIRED'});assert.throws(()=>f.sender.setAuto(true,false),{code:'GUI_AUTH_REQUIRED'});
    const plan=await f.sender.prepare(f.ids,signal());assert.throws(()=>f.sender.commit(plan.id,false),{code:'GUI_AUTH_REQUIRED'});
    const run=f.sender.commit(plan.id,true);await complete(f.sender);
    assert.equal(f.store.getRun(run.runId)!.state,'COMPLETED');assert.equal(f.store.getRun(run.runId)!.mode,'review');assert.equal(f.store.getRun(run.runId)!.sentCount,1);
    const record=f.sender.outbox().items[0];assert.equal(record.state,'SENT_CONFIRMED');assert.equal(record.policyVersion,f.sender.policy().version);
    const events=f.store.events(run.runId).reverse().map(e=>e.type);assert(events.indexOf('SEND_INTENT')<events.indexOf('SEND_CLICK_DISPATCHED'));assert(events.includes('SENT_CONFIRMED'));
    assert.equal(f.actions.filter(a=>a.startsWith('submit:')).length,1);
    assert.throws(()=>f.sender.commit(plan.id,true),{code:'CONFIRMATION_EXPIRED'});
  }finally{await f.close();}
}));

test('first-contact dedup follows an observed recruiter alias to a previous send on another job',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config,2);let chat:ChattingService|undefined;try{
    await review(f.sender,[f.ids[0]]);await complete(f.sender);assert.equal(f.sender.outbox().total,1);
    chat=new ChattingService(f.store,f.sender,{readConversation:async()=>({id:'boss-chat:observed_uid',recruiterId:'observed_uid',recruiterAliases:['observed_uid',f.jobs[0].recruiterId!,f.jobs[1].recruiterId!],jobId:null,name:'匿名招聘人',company:f.jobs[0].company,url:'https://www.zhipin.com/web/geek/chat',identityBound:true,historyComplete:true,messages:[{id:'platform_greeting',direction:'outgoing',text:'平台默认招呼',confirmed:true}],capturedAt:new Date().toISOString()}),prepareReply:async()=>{},submitReply:async()=>{},verifyReply:async()=>({state:'UNKNOWN',message:'unused'})},()=>config);
    await chat.scan();const attempts=f.actions.length,plan=await f.sender.prepare([f.ids[1]],signal());assert(plan.items[0].blocks.some(block=>block.code==='DUPLICATE_SEND'));assert.throws(()=>f.sender.commit(plan.id,true),{code:'DUPLICATE_SEND'});assert.equal(f.sender.outbox().total,1);assert.equal(f.actions.length,attempts);
  }finally{await chat?.close();await f.close();}
}));

test('a previously imported platform greeting routes known recruiter aliases to chat without another first-contact action',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config);let chat:ChattingService|undefined;try{
    chat=new ChattingService(f.store,f.sender,{readConversation:async()=>({id:'boss-chat:known_platform_hr',recruiterId:'known_platform_hr',recruiterAliases:['known_platform_hr',f.jobs[0].recruiterId!],jobId:'previous_job',name:'匿名招聘人',company:f.jobs[0].company,url:'https://www.zhipin.com/web/geek/chat',identityBound:true,historyComplete:true,messages:[{id:'platform_default',direction:'outgoing',text:'平台默认招呼',confirmed:true},{id:'platform_pk',direction:'system',text:'你与该职位竞争者PK情况',confirmed:true}],capturedAt:new Date().toISOString()}),prepareReply:async()=>{},submitReply:async()=>{},verifyReply:async()=>({state:'UNKNOWN',message:'unused'})},()=>config);
    assert.equal((await chat.scan()).state,'WAITING');const plan=await f.sender.prepare(f.ids,signal());assert(plan.items[0].blocks.some(block=>block.code==='ALREADY_CONTACTED'));assert.throws(()=>f.sender.commit(plan.id,true),{code:'ALREADY_CONTACTED'});assert.equal(f.sender.outbox().total,0);assert.equal(f.actions.length,0);
  }finally{await chat?.close();await f.close();}
}));

test('restored permanent first-contact and refusal locks stop new page actions even without the original outbox row',async()=>withModel(goodResponse,async config=>{
  for(const kind of ['initial','rejected']){
    const f=await setup(config);try{
      f.store.db.prepare('INSERT INTO contact_locks(id,kind,job_id,recruiter_id) VALUES(?,?,?,?)').run(randomUUID(),kind,f.jobs[0].id,f.jobs[0].recruiterId!);
      const code=kind==='initial'?'DUPLICATE_SEND':'CONVERSATION_REJECTED',plan=await f.sender.prepare(f.ids,signal());assert(plan.items[0].blocks.some(block=>block.code===code));assert.throws(()=>f.sender.commit(plan.id,true),{code});assert.equal(f.sender.outbox().total,0);assert.equal(f.actions.length,0);
    }finally{await f.close();}
  }
}));

test('AT08/09: Auto is opt-in, serial, enforces last daily slot, and double deduplicates job/recruiter',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config,2);try{
    assert.throws(()=>f.sender.startAuto(),{code:'CONSENT_REQUIRED'});f.sender.savePolicy({...policy,maxPerDay:1,maxPerRun:1},true);f.sender.setAuto(true,true);
    const {runId}=f.sender.startAuto();await complete(f.sender);assert.equal(f.store.getRun(runId)!.sentCount,1);assert.equal(f.sender.budget().usedToday,1);assert.equal(f.sender.outbox().total,1);
    assert.throws(()=>f.sender.startAuto(),{code:'DAILY_LIMIT'});
    assert.throws(()=>f.matching.updateDraft(f.sender.outbox().items[0].draftId,1,'arbitrary replacement'),{code:'OUTBOX_LOCKED'});
    const second=f.jobs[1];f.store.upsertJob({...second,recruiterId:f.jobs[0].recruiterId});
    const report=await f.sender.prepare([f.ids[1]],signal());assert(report.items[0].blocks.some(b=>b.code==='DUPLICATE_SEND'));
  }finally{await f.close();}
}));

test('AT10: click uncertainty locks NEEDS_VERIFY, blocks new sends, and read-only reconciliation never resubmits',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config,2);try{
    f.setSubmitError(true);const {runId}=await review(f.sender,[f.ids[0]]);await complete(f.sender);
    assert.equal(f.store.getRun(runId)!.state,'NEEDS_HUMAN');const record=f.sender.outbox().items[0];assert.equal(record.state,'NEEDS_VERIFY');assert.equal(record.phase,'CLICK_DISPATCHED');assert.equal(f.sender.status().emergencyStopped,true);
    const plan=await f.sender.prepare([f.ids[1]],signal());assert(plan.items[0].blocks.some(b=>b.code==='NEEDS_VERIFY'));
    await f.sender.verify(record.id,signal());assert.equal(f.sender.outbox().items[0].state,'SENT_CONFIRMED');assert.equal(f.actions.filter(a=>a.startsWith('submit:')).length,1);
    assert.equal(f.store.getRun(runId)!.sentCount,1);assert.equal(f.store.getRun(runId)!.needsVerifyCount,0);
    f.sender.reset(true);f.sender.cancel(runId,true);
  }finally{await f.close();}
}));

test('AT10: restart turns every interrupted SENDING into NEEDS_VERIFY and revokes Auto authorization',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config);try{
    f.sender.setAuto(true,true);const run=f.store.createRun('boss'),draft=f.matching.latestDraft(f.jobs[0].id)!;
    f.store.db.prepare("UPDATE runs SET kind='send',execution_mode='auto',state='SENDING',checkpoint_json='{}' WHERE id=?").run(run.id);
    f.store.db.prepare("INSERT INTO send_outbox(id,job_id,recruiter_id,idem_key,draft_id,state,run_id,phase,created_at) VALUES(?,?,?,?,?,'SENDING',?,'CLICK_DISPATCHED',?)").run(randomUUID(),f.jobs[0].id,f.jobs[0].recruiterId,'fixture-idem',draft.id,run.id,'2026-10-22T10:00:00Z');
    f.store.close();const restored=new Store(f.dir);
    try{assert.equal((restored.db.prepare('SELECT state FROM send_outbox').get() as any).state,'NEEDS_VERIFY');assert.equal(restored.getRun(run.id)!.state,'NEEDS_HUMAN');assert.equal(restored.getSetting('sendEmergencyStop'),true);assert.equal((restored.db.prepare('SELECT count(*) n FROM send_authorizations WHERE revoked_at IS NULL').get() as any).n,0);}finally{restored.close();}
    // Reopen the original test handle so the shared cleanup remains valid.
    (f.store as any).db=(new Store(f.dir)).db;
  }finally{await f.close();}
}));

test('AT11/12/14: challenges, login expiry, closed Chrome and unknown structure stop before any intent or click',async()=>withModel(goodResponse,async config=>{
  for(const code of ['BOSS_CHALLENGE','BOSS_LOGIN_REQUIRED','BROWSER_CLOSED','ADAPTER_CHANGED']){
    const f=await setup(config);try{f.sender.setAuto(true,true);f.setInspectError(code);const {runId}=f.sender.startAuto();await complete(f.sender);assert.equal(f.store.getRun(runId)!.state,'NEEDS_HUMAN');assert.equal(f.store.getRun(runId)!.errorCode,code);assert.equal(f.sender.outbox().total,0);assert(!f.actions.some(a=>a.startsWith('submit:')));}finally{await f.close();}
  }
}));

test('AT13: unavailable model service preserves checkpoint and prevents all browser writes',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config);try{
    f.setHealthy(false);f.sender.setAuto(true,true);const {runId}=f.sender.startAuto();await complete(f.sender);assert.equal(f.store.getRun(runId)!.errorCode,'LLM_UNAVAILABLE');assert.equal(f.sender.outbox().total,0);assert.deepEqual(f.actions,[]);
    f.setHealthy(true);f.sender.resume(runId,true);await complete(f.sender);assert.equal(f.store.getRun(runId)!.state,'COMPLETED');assert.equal(f.sender.outbox().total,1);
  }finally{await f.close();}
}));

test('pause/emergency stop block the next mutation; after-intent cancellation is uncertain and cannot auto retry',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config);try{
    f.onPrepare(()=>f.sender.stop());const {runId}=await review(f.sender,f.ids);await complete(f.sender);
    assert.equal(f.sender.outbox().items[0].state,'NEEDS_VERIFY');assert.equal(f.store.getRun(runId)!.needsVerifyCount,1);assert(!f.actions.some(a=>a.startsWith('submit:')));
    const record=f.sender.outbox().items[0];assert.throws(()=>f.sender.reset(true),{code:'NEEDS_VERIFY'});
    assert.throws(()=>f.sender.resolve(record.id,record.version,'not-sent',false),{code:'GUI_AUTH_REQUIRED'});
    f.sender.resolve(record.id,record.version,'not-sent',true);f.sender.reset(true);assert.equal(f.sender.outbox().items[0].state,'NOT_SENT');
    const plan=await f.sender.prepare(f.ids,signal());assert(plan.items[0].blocks.some(b=>b.code==='DUPLICATE_SEND'));
  }finally{await f.close();}
}));

test('confirmation rejects edited drafts, stale facts, hard gaps, low score and demonstration data',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config);try{
    const plan=await f.sender.prepare(f.ids,signal());const draft=f.matching.latestDraft(f.jobs[0].id)!;f.matching.updateDraft(draft.id,draft.version,draft.content);
    assert.throws(()=>f.sender.commit(plan.id,true),{code:'CONTEXT_CHANGED'});assert.equal(f.sender.outbox().total,0);
    const report=f.matching.assessment(f.jobs[0].id)!;report.gaps=[{requirement:'kernel',severity:'hard',reason:'SDK integration only'}];f.store.db.prepare('UPDATE analysis_results SET report_json=? WHERE id=?').run(JSON.stringify(report),report.id);
    const blocked=await f.sender.prepare(f.ids,signal());assert(blocked.items[0].blocks.some(b=>b.code==='HARD_GAP'));
    report.gaps=[];report.score=79;f.store.db.prepare('UPDATE analysis_results SET report_json=? WHERE id=?').run(JSON.stringify(report),report.id);
    assert((await f.sender.prepare(f.ids,signal())).items[0].blocks.some(b=>b.code==='SCORE_BELOW_THRESHOLD'));
    const demoJob={...f.jobs[0],id:'demo:isolated',platformJobId:'isolated',source:'demo' as const};f.store.upsertJob(demoJob);await f.matching.analyze(demoJob.id,signal());const demoDraft=await f.matching.generate(demoJob.id,'natural',signal());const demoItem=f.matching.queue(demoJob.id,demoDraft.id);f.matching.review(demoItem.queueItemId,1);const demo=await f.sender.prepare([demoItem.queueItemId],signal());assert(demo.items[0].blocks.some(b=>b.code==='DEMO_SEND_FORBIDDEN'));
    const fact=f.store.resume().facts[0];f.store.updateFact({id:fact.id,expectedVersion:fact.version,text:fact.text+' 修正'});
    assert((await f.sender.prepare(f.ids,signal())).items[0].blocks.some(b=>['DRAFT_STALE','RESUME_NOT_FROZEN'].includes(b.code)));
  }finally{await f.close();}
}));

test('AT14: restart preserves the remaining checkpoint, requires fresh Auto consent, and never repeats an attempted job',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config,2);let restored:Store|undefined,resumed:SendingService|undefined;
  try{
    f.onVerify(()=>{f.advance(15000);f.setHealthy(false);});f.sender.setAuto(true,true);const {runId}=f.sender.startAuto();await complete(f.sender);
    assert.equal(f.sender.outbox().total,1);assert.equal(f.store.getRun(runId)!.errorCode,'LLM_UNAVAILABLE');
    await f.sender.close();f.store.close();restored=new Store(f.dir);const attempts:string[]=[];
    const transport:SendTransport={...f.transport,prepareGreeting:async job=>{assert(restored!.db.prepare("SELECT id FROM send_outbox WHERE job_id=? AND state='SENDING'").get(job.id));},submitGreeting:async job=>{attempts.push(job.id);},verifyGreeting:async()=>({state:'CONFIRMED',messageId:'second-fixture',message:'confirmed'})};
    resumed=new SendingService(restored,new MatchingService(restored,()=>config),transport,async()=>true,()=>Date.parse('2026-10-22T10:00:15Z'));
    assert.equal(resumed.status().autoModeConsent,false);assert.throws(()=>resumed!.resume(runId,true),{code:'CONSENT_REQUIRED'});
    assert.equal(resumed.checkpoint(runId).remaining.length,1);resumed.setAuto(true,true);resumed.resume(runId,true);await complete(resumed);
    assert.deepEqual(attempts,[f.jobs[1].id]);assert.equal(restored.getRun(runId)!.sentCount,2);assert.equal(resumed.outbox().total,2);assert.equal(restored.getRun(runId)!.state,'COMPLETED');
  }finally{if(restored){await resumed?.close();restored.close();await rm(f.dir,{recursive:true,force:true});}else await f.close();}
}));

test('working hours, expiring confirmation, single execution and sleep between preflight and intent are enforced',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config,2);try{
    f.sender.savePolicy({...policy,startTime:'11:00',endTime:'12:00'},true);assert((await f.sender.prepare([f.ids[0]],signal())).items[0].blocks.some(b=>b.code==='OUTSIDE_WORK_HOURS'));
    f.sender.savePolicy(policy,true);const plan=await f.sender.prepare([f.ids[0]],signal());f.advance(300001);assert.throws(()=>f.sender.commit(plan.id,true),{code:'CONFIRMATION_EXPIRED'});
    const submittedAt:number[]=[];f.onPrepare(()=>{if(!submittedAt.length)f.advance(10000);});f.onSubmit(()=>submittedAt.push(f.now()));f.onVerify(()=>{if(submittedAt.length===1){f.advance(14999);setTimeout(()=>f.advance(1),20);}});
    f.sender.setAuto(true,true);const run=f.sender.startAuto();assert.throws(()=>f.sender.startAuto(),{code:'RUN_ACTIVE'});await complete(f.sender);assert.equal(f.store.getRun(run.runId)!.sentCount,2);assert(f.store.events(run.runId).some(e=>e.type==='INTERVAL_WAIT'));assert(submittedAt[1]-submittedAt[0]>=15000,'slow editor preparation must not shorten the interval between actual submissions');
  }finally{await f.close();}
  const sleep=await setup(config);try{
    const transport={...sleep.transport,inspectCommunication:async(job:JobRecord,s:AbortSignal)=>{const result=await sleep.transport.inspectCommunication(job,s);sleep.advance(60000);return result;}};
    const sender=new SendingService(sleep.store,sleep.matching,transport,async()=>true,()=>Date.parse('2026-10-22T10:00:00Z')+(sleep.actions.length?60000:0));
    sender.setAuto(true,true);const {runId}=sender.startAuto();await complete(sender);assert.equal(sleep.store.getRun(runId)!.errorCode,'SYSTEM_RESUMED');assert.equal(sender.outbox().total,0);assert(!sleep.actions.some(a=>a.startsWith('submit:')));await sender.close();
  }finally{await sleep.close();}
}));

test('GUI capability is required over IPC; MCP-shaped requests and arbitrary payloads cannot grant authorization',async()=>{
  const dir=await mkdtemp('/tmp/jp-m3-ipc-'),guiToken=randomBytes(32).toString('hex'),worker=await startWorker(dir,{guiToken});
  try{
    assert.equal((await callWorker(dir,'send.policy.save',policy)).error?.code,'GUI_AUTH_REQUIRED');
    assert.equal((await callWorker(dir,'send.policy.save',policy,1000,'0'.repeat(64))).error?.code,'GUI_AUTH_REQUIRED');
    assert.equal((await callWorker(dir,'send.policy.save',policy,1000,guiToken)).ok,true);
    assert.equal((await callWorker(dir,'send.auto.set',{enabled:true})).error?.code,'GUI_AUTH_REQUIRED');
    assert.equal((await callWorker(dir,'chat.auto.set',{enabled:true,conversationIds:['fixture'],confirmed:true})).error?.code,'GUI_AUTH_REQUIRED');assert.equal((await callWorker(dir,'chat.commit',{id:randomUUID(),confirmed:true})).error?.code,'GUI_AUTH_REQUIRED');assert(!JSON.stringify((await callWorker(dir,'status')).data).includes(guiToken));
  }finally{await worker.close();await rm(dir,{recursive:true,force:true});}
});

test('editing only API Key revokes Auto and old confirmations without storing any key material in the authorization context',async()=>withModel(goodResponse,async config=>{
  const dir=await mkdtemp('/tmp/jp-m3-env-'),store=new Store(dir);const items=await seedSendQueue(store,config);store.close();const guiToken=randomBytes(32).toString('hex');
  const transport:SendTransport={inspectCommunication:async job=>({job,inspection:{jobId:job.id,recruiterId:job.recruiterId,identityBound:true,composerReady:true,canOpenPreview:false,alreadyContacted:false,message:'fixture',url:job.url,adapterVersion:'fixture'}}),prepareGreeting:async()=>{throw new Error('must not write');},submitGreeting:async()=>{throw new Error('must not send');},verifyGreeting:async()=>({state:'UNKNOWN',message:'fixture'})};
  const worker=await startWorker(dir,{guiToken,application:{transport,clock:()=>Date.parse('2026-10-22T10:00:00Z')}});
  try{
    assert((await callWorker(dir,'llm.env.save',config)).ok);assert((await callWorker(dir,'send.policy.save',policy,1000,guiToken)).ok);assert((await callWorker(dir,'send.auto.set',{enabled:true},1000,guiToken)).ok);
    const first=await callWorker(dir,'send.prepare',{queueIds:[items[0].queueId]});assert(first.ok);
    assert((await callWorker(dir,'llm.env.save',{...config,apiKey:'new-anonymous-key'})).ok);
    assert.equal(((await callWorker(dir,'status')).data as any).autoModeConsent,false);
    const check=new DatabaseSync(`${dir}/jobpilot.sqlite`,{readOnly:true});try{assert(!JSON.stringify(check.prepare('SELECT * FROM settings').all()).includes('new-anonymous-key'));assert.equal((check.prepare("SELECT value_json FROM settings WHERE key='sendEnvironmentRevision'").get() as any).value_json,'2');}finally{check.close();}
    assert.equal((await callWorker(dir,'send.commit',{planId:(first.data as any).id,confirmed:true},1000,guiToken)).error?.code,'CONTEXT_CHANGED');
    assert.equal((await callWorker(dir,'run.start',{profileId:'primary',mode:'auto'})).error?.code,'CONSENT_REQUIRED');
  }finally{await worker.close();await rm(dir,{recursive:true,force:true});}
}));

test('two-message first contact reserves two units and verifies default before AI; partial delivery never repeats default',async()=>withModel(goodResponse,async config=>{
  for(const uncertain of [false,true]){const f=await setup(config);try{
    const inspect=f.transport.inspectCommunication;f.transport.inspectCommunication=async(...args)=>{const result=await inspect(...args);result.inspection.entryKind='instant-send';result.inspection.composerReady=false;return result;};
    f.transport.startContact=async job=>{assert(f.sender.outbox().items[0].defaultPhase==='CLICK_DISPATCHED');f.actions.push('default:'+job.id);};
    f.transport.verifyContact=async()=>{f.advance(15000);return {state:'CONFIRMED',messageId:'default-server-id',message:'confirmed'};};f.setSubmitError(uncertain);
    const plan=await f.sender.prepare(f.ids,signal());assert.equal(plan.items[0].messageUnits,2);const {runId}=f.sender.commit(plan.id,true);await complete(f.sender);
    let row=f.sender.outbox().items[0];assert.equal(row.messageUnits,2);assert.equal(row.defaultPhase,'CONFIRMED');assert.equal(f.sender.budget().usedToday,2);assert(f.actions.indexOf('default:'+f.jobs[0].id)<f.actions.indexOf('prepare:'+f.jobs[0].id));
    if(uncertain){assert.equal(row.state,'NEEDS_VERIFY');assert.equal(row.confirmedUnits,1);assert.equal(f.store.getRun(runId)!.sentCount,1);assert.throws(()=>f.sender.resolve(row.id,row.version,'not-sent',true),{code:'PARTIAL_DELIVERY'});f.sender.resolve(row.id,row.version,'default-only',true);row=f.sender.outbox().items[0];assert.equal(row.state,'PARTIAL_CONFIRMED');assert.equal(f.store.getRun(runId)!.sentCount,1);}
    else {assert.equal(row.state,'SENT_CONFIRMED');assert.equal(row.confirmedUnits,2);assert.equal(f.store.getRun(runId)!.sentCount,2);}
    assert.equal(f.actions.filter(a=>a.startsWith('default:')).length,1);
  }finally{await f.close();}}
}));

test('two-message first contact cannot fit one remaining message slot and Continue is not a first-contact editor',async()=>withModel(goodResponse,async config=>{
  const f=await setup(config);try{
    const original=f.transport.inspectCommunication;f.transport.inspectCommunication=async(...args)=>{const result=await original(...args);result.inspection.entryKind='instant-send';return result;};
    f.sender.savePolicy({...policy,maxPerRun:1,maxPerDay:1},true);const plan=await f.sender.prepare(f.ids,signal());assert(plan.items[0].blocks.some(b=>b.code==='MESSAGE_LIMIT'));assert.throws(()=>f.sender.commit(plan.id,true),{code:'MESSAGE_LIMIT'});assert.equal(f.sender.outbox().total,0);
    f.transport.inspectCommunication=async(...args)=>{const result=await original(...args);return {...result,inspection:{...result.inspection,entryKind:'continue-chat',alreadyContacted:true}};};await f.sender.inspect(f.ids[0],signal());const existing=await f.sender.prepare(f.ids,signal());assert(existing.items[0].blocks.some(b=>b.code==='ALREADY_CONTACTED'));assert.equal(f.actions.filter(a=>a.startsWith('submit:')).length,0);
  }finally{await f.close();}
}));
