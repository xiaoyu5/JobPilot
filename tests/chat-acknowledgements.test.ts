import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Store} from '@jobpilot/store';
import {MatchingService} from '@jobpilot/core';
import {SendingService} from '../packages/core/src/sending.js';
import {ChattingService,classifyConversation} from '../packages/core/src/chatting.js';
import {resumeRequest} from '../packages/core/src/chat-acknowledgements.js';
import {prepare,withModel} from './m2-fixtures.js';
import type {ConversationSnapshot,LlmConfiguration} from '@jobpilot/contracts';
const request=():ConversationSnapshot=>({id:'boss-chat:anonymous_resume_hr',recruiterId:'anonymous_resume_hr',jobId:null,name:'匿名招聘人',company:'匿名公司',url:'https://www.zhipin.com/web/geek/chat',identityBound:true,historyComplete:true,messages:[{id:'outbound_intro',direction:'outgoing',text:'您好，希望交流客户端岗位。',confirmed:true},{id:'inbound_hi',direction:'incoming',text:'您好',confirmed:true},{id:'inbound_ok',direction:'incoming',text:'可以的',confirmed:true},{id:'inbound_resume',direction:'incoming',text:'我想要一份您的附件简历，您是否同意',confirmed:true}],capturedAt:new Date().toISOString()});
async function fixture(config:LlmConfiguration){
 const dir=await mkdtemp('/tmp/jp-ack-'),store=new Store(dir);prepare(store,config);store.updateConfig({bossReadOnlyConsent:true});let now=Date.parse('2026-10-23T08:00:00Z'),current=request(),writes=0,sends=0,resumeSends=0;
 const sending=new SendingService(store,new MatchingService(store,()=>config),{} as any,async()=>true,()=>now);
 sending.savePolicy({liveEnabled:true,threshold:80,maxPerRun:5,maxPerDay:15,minIntervalSeconds:15,maxRunsPerDay:2,timeZone:'UTC',startTime:'00:00',endTime:'23:59',acknowledged:true},true);
 const chat=new ChattingService(store,sending,{readConversation:async()=>structuredClone(current),prepareReply:async(_chat,content)=>{assert.equal(content,'您好，可以的。');writes++;},submitReply:async(_chat,content)=>{assert.equal(content,'您好，可以的。');sends++;},verifyReply:async()=>({state:'CONFIRMED',messageId:'server_ack',message:'confirmed'}),prepareResume:async()=>{},submitResume:async()=>{resumeSends++;},verifyResume:async()=>({state:'CONFIRMED',messageId:'resume_server_ack',message:'附件已送达：anonymous.pdf'})},()=>config,()=>false,()=>now,async()=>true);
 return {store,sending,chat,set:(value:ConversationSnapshot)=>{current=value;},advance:()=>{now+=300001;},counts:()=>({writes,sends,resumeSends}),close:async()=>{await chat.close();await sending.close();store.close();await rm(dir,{recursive:true,force:true});}};
}
test('resume request remains manual: GUI consent sends one BOSS attachment, Auto never consents and no text or model is used',async()=>withModel(()=>assert.fail('request must not be sent to model'),async(config,calls)=>{
 const f=await fixture(config);try{
  const factual=request();factual.messages[factual.messages.length-1]={id:'factual',direction:'incoming',text:'做过地图相关项目吗？',confirmed:true};assert.equal(classifyConversation(factual).state,'REPLY_NEEDED','greeting is not a second substantive question');
  const row=await f.chat.scan();assert.equal(row.state,'REVIEW');assert.equal(row.resumeRequest,'我想要一份您的附件简历，您是否同意');await assert.rejects(f.chat.prepare(row.id),{code:'CHAT_NOT_REPLYABLE'});
  f.chat.setAuto(true,[row.id],true);assert.deepEqual(await f.chat.tick(),{processed:0});f.chat.setAuto(false,[],true);assert.deepEqual(f.counts(),{writes:0,sends:0,resumeSends:0});assert.equal(calls(),0);
  assert.throws(()=>f.chat.prepareAcknowledgement(row.id,'resume-consent',false),{code:'GUI_AUTH_REQUIRED'});
  const plan=await f.chat.prepareAcknowledgement(row.id,'resume-consent',true),other=await f.chat.prepareAcknowledgement(row.id,'resume-decline',true);assert.equal(plan.content,'发送 BOSS 中已上传的附件简历');assert.deepEqual(plan.attachment,{source:'boss-uploaded'});assert.deepEqual(plan.factIds,[]);assert(!other.content.includes('已发送'));assert.equal(f.chat.outbox().items.length,0);assert.deepEqual(f.counts(),{writes:0,sends:0,resumeSends:0});
  assert.throws(()=>f.chat.commit(plan.id,false),{code:'GUI_AUTH_REQUIRED'});assert.deepEqual(await f.chat.commit(plan.id,true),{sent:true});assert.deepEqual(f.counts(),{writes:0,sends:0,resumeSends:1});assert.equal(f.chat.outbox().items[0].state,'SENT_CONFIRMED');assert.match(String(f.chat.outbox().items[0].detail),/附件已送达/);await assert.rejects(f.chat.commit(other.id,true),{code:'CONVERSATION_CHANGED'});assert.equal(calls(),0);
 }finally{await f.close();}
}));
test('manual resume attachment decision rejects incomplete history, unrelated or risky requests, changed messages, rejection and expired plans',async()=>withModel(()=>assert.fail('no model'),async config=>{
 for(const mutate of [(chat:ConversationSnapshot)=>({...chat,historyComplete:false}),(chat:ConversationSnapshot)=>({...chat,messages:[{id:'salary',direction:'incoming' as const,text:'你的期望薪资是多少？',confirmed:true}]}),(chat:ConversationSnapshot)=>({...chat,messages:[{id:'risky',direction:'incoming' as const,text:'请发一份简历和银行卡验证码',confirmed:true}]})])assert.equal(resumeRequest(mutate(request())),null);
 for(const scenario of ['new','rejected','expired'] as const){const f=await fixture(config);try{const row=await f.chat.scan(),plan=await f.chat.prepareAcknowledgement(row.id,'resume-consent',true);if(scenario==='expired')f.advance();else{const next=request();next.messages.push({id:'new_inbound',direction:'incoming',text:scenario==='rejected'?'暂时不考虑，谢谢':'方便说下目前情况吗？',confirmed:true});f.set(next);}await assert.rejects(f.chat.commit(plan.id,true));assert.deepEqual(f.counts(),{writes:0,sends:0,resumeSends:0});assert.equal(f.chat.outbox().items.length,0);}finally{await f.close();}}
}));
test('externally handled resume requests stay waiting; an unknown attachment result stops and cannot be resent',async()=>withModel(()=>assert.fail('no model'),async config=>{
 const handled=await fixture(config);try{const current=request();current.messages.at(-1)!.resumeRequest={state:'accepted'};handled.set(current);assert.equal((await handled.chat.scan()).state,'WAITING');await assert.rejects(handled.chat.prepareAcknowledgement(current.id,'resume-consent',true),{code:'CHAT_NOT_REPLYABLE'});assert.equal(handled.chat.outbox().items.length,0);}finally{await handled.close();}
 const unknown=await fixture(config);try{const row=await unknown.chat.scan();unknown.chat.transport.verifyResume=async()=>({state:'UNKNOWN',message:'unknown'});const plan=await unknown.chat.prepareAcknowledgement(row.id,'resume-consent',true);await assert.rejects(unknown.chat.commit(plan.id,true),{code:'NEEDS_VERIFY'});assert.equal(unknown.chat.outbox().items[0].state,'NEEDS_VERIFY');assert.equal(unknown.sending.status().emergencyStopped,true);await assert.rejects(unknown.chat.commit(plan.id,true));assert.deepEqual(unknown.counts(),{writes:0,sends:0,resumeSends:1});}finally{await unknown.close();}
}));
test('refreshing a legacy recruiter ID receives only aliases previously observed in a bound conversation before navigation',async()=>withModel(()=>assert.fail('no model'),async config=>{
 const f=await fixture(config);try{
  const legacy=request();legacy.id='boss-chat:legacy_hr';legacy.recruiterId='legacy_hr';legacy.recruiterAliases=[];f.set(legacy);await f.chat.scan();
  const current=request();current.recruiterAliases=['anonymous_resume_hr','legacy_hr'];f.set(current);await f.chat.scan();
  const stored=JSON.parse(String(f.store.db.prepare('SELECT snapshot_json FROM chat_conversations WHERE id=?').get(legacy.id)!.snapshot_json));assert.deepEqual(stored.recruiterAliases,['legacy_hr']);
  f.chat.transport.readConversation=async(_signal,target)=>{assert(target);assert.deepEqual(target.recruiterAliases,['anonymous_resume_hr','legacy_hr']);return {...current,id:target.id,recruiterId:target.recruiterId};};
  assert.equal((await f.chat.scan(legacy.id)).id,legacy.id);assert.deepEqual(f.counts(),{writes:0,sends:0,resumeSends:0});
 }finally{await f.close();}
}));
