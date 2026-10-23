import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Store} from '@jobpilot/store';
import {MatchingService} from '@jobpilot/core';
import {SendingService} from '../packages/core/src/sending.js';
import {prepare,withModel,goodResponse} from './m2-fixtures.js';
test('natural greeting retains original evidence, independent verification, immutable edit audit and mandatory human review even in Auto',async()=>{
 let malicious=false;
 await withModel(body=>{const input=JSON.parse(body.messages[1].content);if(input.claims)return {supported:true,issues:[]};if(input.facts)return {claims:[{factId:input.facts[0].factId,text:malicious?'我有20年研发经验，独立开发P2P内核。':'我在扫地机器人客户端项目中，曾负责地图协议解析与点云渲染相关工作，具备与岗位方向相关的实践经验。'}]};return goodResponse(body);},async config=>{
  const dir=await mkdtemp('/tmp/jp-natural-'),store=new Store(dir),base=prepare(store,config),matching=new MatchingService(store,()=>config);
  const job={...base,id:'boss:natural',source:'boss' as const,recruiterId:'natural_hr'};store.upsertJob(job);await matching.analyze(job.id,new AbortController().signal);
  try{
   const draft=await matching.generate(job.id,'rewrite',new AbortController().signal);assert.equal(draft.audit.status,'PASS');assert.equal(draft.requiresReview,true);assert(draft.statements[0].sourceText?.includes('Welgoo'));assert(!draft.content.includes('Welgoo'));assert.equal(matching.validateForSend(draft.id).draft.id,draft.id);
   const queued=matching.queue(job.id,draft.id),sending=new SendingService(store,matching,{} as any,async()=>true);assert((sending as any).itemBlocks(queued.queueItemId,'auto').some((block:any)=>block.code==='REVIEW_REQUIRED'));matching.review(queued.queueItemId,1);assert(!(sending as any).itemBlocks(queued.queueItemId,'auto').some((block:any)=>block.code==='REVIEW_REQUIRED'));
   const edit=matching.updateDraft(draft.id,1,draft.content.replace('地图协议解析','操作系统内核'));assert.equal(edit.audit.status,'BLOCK');await sending.close();
   malicious=true;const job2={...job,id:'boss:natural2',platformJobId:'natural2'};store.upsertJob(job2);await matching.analyze(job2.id,new AbortController().signal);const blocked=await matching.generate(job2.id,'rewrite',new AbortController().signal);assert.equal(blocked.audit.status,'BLOCK');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
 });
});

test('natural copy approval is GUI-only even for a regular authenticated IPC client',async()=>{
 const {Application}=await import('../packages/worker/src/application.js');
 await withModel(body=>{const input=JSON.parse(body.messages[1].content);if(input.claims)return {supported:true,issues:[]};if(input.facts)return {claims:[{factId:input.facts[0].factId,text:'我在扫地机器人客户端项目中，曾负责地图协议解析与点云渲染相关工作，具备与岗位方向相关的实践经验。'}]};return goodResponse(body);},async config=>{
  const dir=await mkdtemp('/tmp/jp-natural-gui-'),app=new Application(dir),signal=new AbortController().signal;
  try{await app.dispatch('llm.env.save',config,signal);const job=prepare(app.store,config);await app.matching.analyze(job.id,signal);const draft=await app.matching.generate(job.id,'rewrite',signal),queue=app.matching.queue(job.id,draft.id);await assert.rejects(()=>app.dispatch('queue.review',{id:queue.queueItemId,expectedVersion:1},signal),{code:'GUI_AUTH_REQUIRED'});await app.dispatch('queue.review',{id:queue.queueItemId,expectedVersion:1},signal,true);assert.equal(app.matching.listQueue()[0].state,'REVIEWED');}finally{await app.close();await rm(dir,{recursive:true,force:true});}
 });
});
