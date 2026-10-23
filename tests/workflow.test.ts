import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Store} from '@jobpilot/store';
import {MatchingService} from '@jobpilot/core';
import {SendingService} from '../packages/core/src/sending.js';
import {WorkflowService} from '../packages/core/src/workflow.js';
import {prepare,withModel,goodResponse} from './m2-fixtures.js';
const until=async(fn:()=>boolean)=>{for(let i=0;i<300&&!fn();i++)await new Promise(resolve=>setTimeout(resolve,10));assert(fn(),'task did not settle');};
test('workflow preview collects and analyzes only its jobs, safely resumes details checkpoint and daily schedule never grants Auto',async()=>{
 await withModel(goodResponse,async config=>{
  const root=await mkdtemp('/tmp/jp-workflow-'),store=new Store(root);const base=prepare(store,config);store.updateConfig({bossReadOnlyConsent:true});
  const profile={id:'hardware',name:'智能硬件',keyword:'iOS',searchUrl:'',maxJobs:5};store.saveSearch(profile);assert.equal(store.listSearch().length,2);assert.equal(store.getSearch('hardware')!.name,'智能硬件');
  const matching=new MatchingService(store,()=>config),sending=new SendingService(store,matching,{} as any,async()=>true);let reads=0,fail=true,now=Date.parse('2026-10-23T02:00:00Z');
  const browser={search:async(_p:any,_signal:any,onJob:any)=>{onJob({...base,id:'boss:workflow_a',source:'boss',platformJobId:'workflow_a'});onJob({...base,id:'boss:workflow_b',source:'boss',platformJobId:'workflow_b'});return 2;},readJob:async(job:any)=>{reads++;if(job.id.endsWith('b')&&fail)throw new Error('fixture interrupt');return job;}};
  let workflow=new WorkflowService(store,matching,sending,browser,()=>false,()=>now);
  try{
   const {runId}=workflow.start({profileId:'hardware',mode:'preview'});await until(()=>!workflow.busy);assert.equal(store.getRun(runId)!.state,'NEEDS_HUMAN');assert.equal(reads,2);
   fail=false;workflow.resume(runId);await until(()=>!workflow.busy);assert.equal(reads,3,'completed JD must not be fetched again');assert.equal(store.getRun(runId)!.state,'COMPLETED');assert.equal(store.getRun(runId)!.draftedCount,2);assert.equal(store.db.prepare('SELECT count(*) n FROM send_outbox').get()!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM review_queue').get()!.n,2);
   assert.throws(()=>workflow.saveSchedule({profileId:'hardware',mode:'preview',time:'10:00',timeZone:'Asia/Shanghai',enabled:true},false),/界面/);
   assert.throws(()=>workflow.start({profileId:'hardware',mode:'auto'}),/独立启用/);assert.throws(()=>workflow.start({profileId:'hardware',mode:'auto',draftStyle:'rewrite'}),/人工审核/);
   workflow.saveSchedule({profileId:'hardware',mode:'preview',time:'10:00',timeZone:'Asia/Shanghai',enabled:true},true);workflow.tick();await until(()=>!workflow.busy);const runs=store.listRuns().length;workflow.tick();assert.equal(store.listRuns().length,runs,'same local date runs once');
   await workflow.close();workflow=new WorkflowService(store,matching,sending,browser,()=>false,()=>now);assert.equal(workflow.schedule().enabled,false,'restart does not arm a schedule');workflow.saveSchedule({profileId:'hardware',mode:'preview',time:'10:00',timeZone:'Asia/Shanghai',enabled:true},true);now+=120000;workflow.tick();assert.equal(workflow.schedule().enabled,false,'sleep revokes schedule');
  }finally{await workflow.close();await sending.close();store.close();await rm(root,{recursive:true,force:true});}
 });
});
