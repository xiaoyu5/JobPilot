import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Store} from '@jobpilot/store';
import {MatchingService,ruleFilter,statements,auditGreeting} from '@jobpilot/core';
import {MatchingPolicy,type LlmConfiguration,type Assessment,type Draft} from '@jobpilot/contracts';
import {Application} from '../packages/worker/src/application.js';
import {demoJobs} from '../fixtures/boss/demo-jobs.js';

import {mapFact,sdkFact,withModel,goodResponse,prepare} from './m2-fixtures.js';

test('AT04: explicit filters, invalid jobs and pure backend skip before any model request',async()=>{
  const policy=MatchingPolicy.parse({}),job={...demoJobs()[0],title:'Python 后端开发',jdText:'Django PostgreSQL 微服务开发'};
  assert.equal(ruleFilter(job,policy)[0].code,'PURE_BACKEND');
  assert.equal(ruleFilter({...job,title:'iOS Python 数据接口客户端'},policy).length,0);
  assert.equal(ruleFilter({...job,title:'iOS',city:'上海',salary:'10-15K'},MatchingPolicy.parse({cities:['深圳'],minimumSalaryK:20})).length,2);
  assert.equal(ruleFilter({...job,title:'iOS',city:'',salary:'面议'},MatchingPolicy.parse({cities:['深圳'],minimumSalaryK:20})).length,0);
  await withModel(()=>{throw new Error('must not call');},async(config,calls)=>{
    const dir=await mkdtemp('/tmp/jp-m2-rule-'),store=new Store(dir);try{prepare(store,config);store.upsertJob(job);const report=await new MatchingService(store,()=>config).analyze(job.id,new AbortController().signal);assert.equal(report.decision,'SKIP_RULE');assert.equal(calls(),0);}finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('AT03: invalid JSON has one repair, then REVIEW; unknown IDs and invented strength claims are rejected',async()=>{
  for(const mode of ['invalid','unknown','invented'] as const)await withModel(body=>{
    if(mode==='invalid')return '```json\n{"score":100}\n```';
    const value=goodResponse(body);if(value.strengths){if(mode==='unknown')value.evidenceFactIds=[randomUUID()];else value.strengths[0].reason='独立实现了 P2P 协议栈内核，提升性能 80%。';}return value;
  },async(config,calls)=>{
    const dir=await mkdtemp('/tmp/jp-m2-json-'),store=new Store(dir);try{
      const job=prepare(store,config),core=new MatchingService(store,()=>config),report=await core.analyze(job.id,new AbortController().signal);
      assert.equal(report.decision,'REVIEW');assert.equal(report.score,null);assert.equal(report.evidenceFactIds.length,0);assert.equal(calls(),2);
      await assert.rejects(core.generate(job.id,'natural',new AbortController().signal),{code:'DRAFT_NOT_ELIGIBLE'});
    }finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('AT05/06: P2P kernel gap is hard, map role cites approved Welgoo; greetings preserve whole facts and edits invalidate review',async()=>{
  await withModel(goodResponse,async(config,calls)=>{
    const dir=await mkdtemp('/tmp/jp-m2-evidence-');let store=new Store(dir);try{
      const job=prepare(store,config);let core=new MatchingService(store,()=>config);const signal=new AbortController().signal;
      let report=await core.analyze(job.id,signal);assert.equal(report.decision,'RECOMMEND');assert.equal(report.strengths[0].reason,mapFact);
      const cached=await core.analyze(job.id,signal);assert.equal(cached.id,report.id);assert.equal(calls(),1);
      const draft=await core.generate(job.id,'natural',signal);assert.equal(draft.audit.status,'PASS');assert(draft.content.includes(mapFact));assert([...draft.content].length>=50&&[...draft.content].length<=100);
      assert.equal((await core.generate(job.id,'natural',signal)).id,draft.id);assert.equal(calls(),2);
      const queued=core.queue(job.id,draft.id);assert.equal(core.queue(job.id,draft.id).queueItemId,queued.queueItemId);assert.equal(core.listQueue().length,1);
      core.review(queued.queueItemId,1);assert.equal(core.listQueue()[0].state,'REVIEWED');
      const edited=core.updateDraft(draft.id,1,draft.content+'我独立实现了 P2P 内核，提升性能 80%。');assert.equal(edited.audit.status,'BLOCK');assert.equal(edited.manualOverride,true);assert.equal(core.listQueue()[0].state,'BLOCKED');
      assert.equal((store.db.prepare('SELECT count(*) n FROM draft_revisions').get() as any).n,2);
      assert.throws(()=>core.review(queued.queueItemId,core.listQueue()[0].version),{code:'DRAFT_BLOCKED'});
      const repaired=core.updateDraft(draft.id,2,draft.content);assert.equal(repaired.audit.status,'PASS');assert.equal(core.listQueue()[0].state,'PENDING');
      store.close();store=new Store(dir);core=new MatchingService(store,()=>config);assert.equal(core.listQueue()[0].draft.version,3);
      const fact=store.resume().facts[0];store.updateFact({id:fact.id,expectedVersion:fact.version,approved:false});assert.equal(core.listQueue()[0].state,'STALE');assert.equal(core.listQueue()[0].draft.stale,true);
      assert.throws(()=>core.queue(job.id,draft.id),{code:'DRAFT_STALE'});
      // Freeze only SDK-integration evidence. Even a high score cannot erase the kernel gap.
      store.freezeResume(store.resume().version);
      const p2p={...job,id:'demo:p2p',platformJobId:'p2p',title:'iOS P2P 内核工程师',jdText:'需独立实现 P2P 协议栈和内核，不仅是 SDK 集成。',jdHash:'kernel'};store.upsertJob(p2p);
      report=await core.analyze(p2p.id,signal);assert.equal(report.decision,'REVIEW');assert(report.gaps.some(g=>g.severity==='hard'&&g.reason.includes('SDK')));
      const qualified=await core.generate(p2p.id,'natural',signal);assert(qualified.content.includes(sdkFact));assert(!qualified.content.includes('我独立实现'));
      assert.equal((await readFile(`${dir}/jobpilot.sqlite`)).includes(config.apiKey!),false);
    }finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('AT07: Dry Run never invokes browser operations, persists progress, queues only audited drafts and obeys pause',async()=>{
  await withModel(goodResponse,async(config)=>{
    const dir=await mkdtemp('/tmp/jp-m2-dry-'),app=new Application(dir),signal=new AbortController().signal;
    try{
      const job=prepare(app.store,config);await app.dispatch('llm.env.save',config,signal);
      for(const key of ['search','readJob','open','openLogin'] as const)(app.browser as any)[key]=()=>{throw new Error('Dry Run must not call browser');};
      const started=await app.dispatch('dryrun.start',{source:'demo',jobIds:[job.id],maxJobs:1},signal) as any;
      for(let i=0;i<100&&['ANALYZING','DRAFTING'].includes(app.store.getRun(started.runId)!.state);i++)await new Promise(r=>setTimeout(r,10));
      const run=app.store.getRun(started.runId)!;assert.equal(run.state,'COMPLETED');assert.equal(run.kind,'dry-run');assert.equal(run.processedCount,1);assert.equal(run.draftedCount,1);assert.equal(app.matching.listQueue().length,1);assert.equal(app.status().mode,'preview');assert.equal(app.status().autoModeConsent,false);
      assert.equal((app.store.db.prepare('SELECT count(*) n FROM send_outbox').get() as any).n,0);
      assert.equal((await app.dispatch('queue.list',undefined,signal) as any).items.length,1);
    }finally{await app.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('JD, policy and model changes invalidate cached results and reject in-flight responses',async()=>{
  let core:MatchingService,jobId:string,changed=false;
  await withModel(body=>{if(!changed){changed=true;core.savePolicy({...core.policy(),recommendScore:85});}return goodResponse(body);},async(config)=>{
    const dir=await mkdtemp('/tmp/jp-m2-race-'),store=new Store(dir);try{
      const job=prepare(store,config);jobId=job.id;core=new MatchingService(store,()=>config);
      await assert.rejects(core.analyze(job.id,new AbortController().signal),{code:'CONTEXT_CHANGED'});assert.equal(core.assessment(job.id),null);
      const report=await core.analyze(job.id,new AbortController().signal);const draft=await core.generate(job.id,'natural',new AbortController().signal);core.queue(job.id,draft.id);
      core.savePolicy({...core.policy(),recommendScore:86});assert.equal(core.listQueue()[0].state,'STALE');assert.equal(core.assessment(job.id)!.stale,true);
      core.savePolicy({...core.policy(),recommendScore:85});const next=await core.analyze(job.id,new AbortController().signal);assert.notEqual(next.id,report.id);assert.equal((await core.analyze(job.id,new AbortController().signal)).id,next.id);
      store.upsertJob({...job,jdText:job.jdText+'新要求',jdHash:'map-v2'});assert.equal(core.assessment(job.id)!.stale,true);
      store.updateConfig({llm:{...store.config().llm!,model:'another-model'}});assert.equal(core.latestDraft(job.id)!.stale,true);
    }finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('audit rejects removed qualifiers, unsupported claims, private contacts, placeholders and excessive length',()=>{
  const fact={id:randomUUID(),approved:true,text:sdkFact} as any,catalog=statements([fact]),policy=MatchingPolicy.parse({});
  for(const content of [sdkFact.replace('未独立','独立'),'您好，我精通所有技术，电话 13800138000。','您好，{{公司}}，我有十年经验。','您好。'+sdkFact+'我优化了 80%。','a'.repeat(200)])assert.equal(auditGreeting(content,catalog,policy).status,'BLOCK');
});

test('pause cancels an active model request, preserves progress, and releases the shared model guard',async()=>{
  let began!:()=>void;const started=new Promise<void>(r=>began=r);
  await withModel(async body=>{began();await new Promise(r=>setTimeout(r,300));return goodResponse(body);},async config=>{
    const dir=await mkdtemp('/tmp/jp-m2-pause-'),app=new Application(dir),signal=new AbortController().signal;
    try{
      const job=prepare(app.store,config);await app.dispatch('llm.env.save',config,signal);
      const {runId}=await app.dispatch('dryrun.start',{source:'demo',jobIds:[job.id]},signal) as any;await started;
      await assert.rejects(app.dispatch('analysis.analyze',{jobId:job.id},signal),{code:'LLM_BUSY'});
      await app.dispatch('run.pause',{id:runId},signal);
      for(let i=0;i<100&&app.store.getRun(runId)!.state==='ANALYZING';i++)await new Promise(r=>setTimeout(r,10));
      assert.equal(app.store.getRun(runId)!.state,'PAUSED');assert.equal(app.store.getRun(runId)!.processedCount,0);assert.equal(app.matching.assessment(job.id),null);
      assert.equal(app.matching.listQueue().length,0);
    }finally{await app.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('invalid response can be retried explicitly and successful JSON repair does not cache invalid attempts',async()=>{
  await withModel((body,calls)=>calls===1?'not JSON':goodResponse(body),async(config,calls)=>{
    const dir=await mkdtemp('/tmp/jp-m2-repair-'),store=new Store(dir);try{
      const job=prepare(store,config),core=new MatchingService(store,()=>config);
      const report=await core.analyze(job.id,new AbortController().signal);assert.equal(report.score,90);assert.equal(calls(),2);
    }finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('application startup and saved configuration remain usable while model credentials are locked',async()=>{
  const dir=await mkdtemp('/tmp/jp-m2-locked-'),app=new Application(dir),signal=new AbortController().signal;
  try{
    const job=prepare(app.store,{baseUrl:'http://localhost:1/v1',model:'fixture',timeoutMs:100,allowLan:false});
    assert.equal(app.status().llm.sessionReady,false);
    await assert.rejects(app.dispatch('analysis.analyze',{jobId:job.id},signal),{code:'LLM_LOCKED'});
    assert.equal((await app.dispatch('resume.list',undefined,signal) as any).approvedCount,2);
    assert.equal((await app.dispatch('jobs.list',{},signal) as any).total,1);
    await app.dispatch('llm.env.save',{baseUrl:'http://localhost:1/v1',model:'fixture',timeoutMs:100,apiKey:''},signal);assert.equal(app.status().llm.sessionReady,true);
    await app.dispatch('config.update',{llm:{baseUrl:'http://localhost:2/v1',model:'fixture',timeoutMs:100}},signal);assert.equal(app.status().llm.sessionReady,false);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
