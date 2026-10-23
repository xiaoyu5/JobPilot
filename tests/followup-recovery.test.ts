import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Store} from '@jobpilot/store';
import {MatchingService} from '@jobpilot/core';
import {SendingService,type SendTransport} from '../packages/core/src/sending.js';
import {withModel,goodResponse} from './m2-fixtures.js';
import {seedSendQueue} from './m3-fixtures.js';
const signal=()=>new AbortController().signal;
async function fixture(config:any){
  const dir=await mkdtemp('/tmp/jp-followup-'),store=new Store(dir),[item]=await seedSendQueue(store,config,1),matching=new MatchingService(store,()=>config);let now=Date.parse('2026-10-23T10:00:00Z'),proof=false,uncertain=false;
  const actions:string[]=[];const transport:SendTransport={inspectCommunication:async job=>({job,inspection:{jobId:job.id,recruiterId:job.recruiterId,identityBound:true,composerReady:false,canOpenPreview:false,alreadyContacted:false,entryKind:'instant-send',message:'fixture',url:job.url,adapterVersion:'fixture'}}),startContact:async()=>{actions.push('default');},verifyContact:async()=>proof?{state:'CONFIRMED',messageId:'visible-receipt:original_default',message:'visible receipt'}:{state:'UNKNOWN',message:'unknown modal'},prepareGreeting:async()=>{actions.push('prepare-ai');},submitGreeting:async()=>{actions.push('submit-ai');if(uncertain)throw new Error('lost after AI click');},verifyGreeting:async()=>({state:'CONFIRMED',messageId:'visible-receipt:exact_ai',message:'visible receipt'})};
  const sender=new SendingService(store,matching,transport,async()=>true,()=>now);sender.savePolicy({liveEnabled:true,threshold:80,maxPerRun:5,maxPerDay:15,minIntervalSeconds:15,maxRunsPerDay:2,timeZone:'UTC',startTime:'00:00',endTime:'23:59',acknowledged:true},true);
  const plan=await sender.prepare([item.queueId],signal());sender.commit(plan.id,true);await sender.active?.promise;const record=sender.outbox().items[0];assert.equal(record.phase,'INTENT');assert.equal(record.state,'NEEDS_VERIFY');assert.deepEqual(actions,['default']);
  return {store,sender,record,actions,ready:()=>{proof=true;now+=20000;},uncertain:()=>{uncertain=true;},close:async()=>{await sender.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
test('explicit single-AI recovery preserves the original intent, quota and default greeting, and requires a new native GUI confirmation',async()=>withModel(goodResponse,async config=>{
  const f=await fixture(config);try{
    await assert.rejects(f.sender.prepareFollowup(f.record.id,signal()),{code:'NEEDS_VERIFY'});f.ready();const plan=await f.sender.prepareFollowup(f.record.id,signal());assert.equal(plan.items[0].messageUnits,1);assert.equal(plan.items[0].content,f.record.content);assert.deepEqual(f.actions,['default']);
    assert.throws(()=>f.sender.commit(plan.id,true),{code:'INVALID_SEND_PLAN'});assert.throws(()=>f.sender.commitFollowup(plan.id,false),{code:'GUI_AUTH_REQUIRED'});f.sender.commitFollowup(plan.id,true);await f.sender.active?.promise;
    assert.deepEqual(f.actions,['default','prepare-ai','submit-ai']);const result=f.sender.outbox().items[0];assert.equal(result.state,'SENT_CONFIRMED');assert.equal(result.confirmedUnits,2);assert.equal(f.sender.outbox().total,1);assert.equal(f.sender.budget().usedToday,2);assert.equal(f.sender.budget().runsToday,1);assert.equal(f.store.getRun(result.runId)!.sentCount,2);assert.equal(f.store.getRun(result.runId)!.needsVerifyCount,0);assert.equal(f.sender.status().emergencyStopped,true);assert.equal(f.sender.status().autoModeConsent,false);
    assert.throws(()=>f.sender.commitFollowup(plan.id,true),{code:'CONFIRMATION_EXPIRED'});await assert.rejects(f.sender.prepareFollowup(result.id,signal()),{code:'FOLLOWUP_NOT_ELIGIBLE'});
  }finally{await f.close();}
}));
test('AI-click uncertainty and an intervening emergency stop cannot be retried through single-AI recovery',async()=>withModel(goodResponse,async config=>{
  for(const mode of ['uncertain','stop'] as const){const f=await fixture(config);try{
    f.ready();const plan=await f.sender.prepareFollowup(f.record.id,signal());
    if(mode==='stop'){f.sender.stop();assert.throws(()=>f.sender.commitFollowup(plan.id,true),{code:'CONTEXT_CHANGED'});assert.deepEqual(f.actions,['default']);}
    else{f.uncertain();f.sender.commitFollowup(plan.id,true);await f.sender.active?.promise;const record=f.sender.outbox().items[0];assert.equal(record.phase,'CLICK_DISPATCHED');assert.equal(record.confirmedUnits,1);assert.equal(record.state,'NEEDS_VERIFY');assert.equal(f.store.getRun(record.runId)!.needsVerifyCount,1);await assert.rejects(f.sender.prepareFollowup(record.id,signal()),{code:'FOLLOWUP_NOT_ELIGIBLE'});assert.equal(f.actions.filter(x=>x==='submit-ai').length,1);}
  }finally{await f.close();}}
}));
