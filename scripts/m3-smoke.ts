import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Store} from '@jobpilot/store';
import {MatchingService} from '@jobpilot/core';
import {AppError,type ConversationSnapshot,type LlmConfiguration} from '@jobpilot/contracts';
import {SendingService,type SendTransport} from '../packages/core/src/sending.js';
import {ChattingService,type ChatTransport} from '../packages/core/src/chatting.js';
import {readEnvironment} from '../packages/worker/src/environment.js';
import {callWorker} from '../packages/worker/src/client.js';
import {runtimePaths} from '../packages/worker/src/paths.js';
import {withModel} from '../tests/m2-fixtures.js';

// Only synthetic conversations/facts in an isolated temporary database. No
// Chrome transport is constructed; every page-write/send method fails closed.
const live=process.argv.includes('--live');
const mapFact='在匿名地图演示项目中，负责二进制地图协议解析与点云渲染。';
const sdkFact='在匿名摄像头演示项目中仅集成 P2P SDK，未独立实现协议栈或内核。';
async function smoke(config:LlmConfiguration){
  const dir=await mkdtemp('/tmp/jp-m3-model-'),store=new Store(dir);
  let writes=0;
  const blocked=async()=>{writes++;throw new Error('This smoke test has no browser or delivery transport');};
  const sender=new SendingService(store,new MatchingService(store,()=>config),{prepareGreeting:blocked,submitGreeting:blocked,inspectCommunication:blocked,verifyGreeting:blocked} as SendTransport,async()=>false);
  const snapshot=(recruiterId:string,text:string,direction:'incoming'|'outgoing'='incoming'):ConversationSnapshot=>({id:`boss-chat:${recruiterId}`,recruiterId,jobId:null,name:'匿名测试招聘人',company:'匿名测试公司',url:'https://www.zhipin.com/web/geek/chat',identityBound:true,historyComplete:true,messages:[{id:`message_${recruiterId}`,direction,text,confirmed:true}],capturedAt:new Date().toISOString()});
  let current=snapshot('anonymous_wait','平台默认招呼','outgoing');
  const transport:ChatTransport={readConversation:async()=>structuredClone(current),prepareReply:blocked,submitReply:blocked,verifyReply:blocked};
  const chat=new ChattingService(store,sender,transport,()=>config);
  try{
    const {apiKey,...settings}=config;store.updateConfig({llm:settings,bossReadOnlyConsent:true});
    store.importFacts('anonymous-m3.txt',randomUUID(),[mapFact,sdkFact].map((text,index)=>({text,category:'project',source:{file:'anonymous-m3.txt',kind:'text',paragraph:index+1,quote:text}})));
    // Test fixtures only. The user's actual database/facts are never opened.
    for(const fact of store.resume().facts)store.updateFact({id:fact.id,expectedVersion:fact.version,approved:true});
    store.freezeResume(store.resume().version);
    current.messages.push({id:'anonymous_platform_pk',direction:'system',text:'你与该职位竞争者PK情况',confirmed:true});
    const waiting=await chat.scan();assert.equal(waiting.state,'WAITING');await assert.rejects(chat.prepare(waiting.id),{code:'CHAT_NOT_REPLYABLE'});
    current=snapshot('anonymous_rejected','暂不考虑，谢谢');const rejected=await chat.scan();assert.equal(rejected.state,'REJECTED');await assert.rejects(chat.prepare(rejected.id),{code:'CONVERSATION_REJECTED'});
    current=snapshot('anonymous_question','请介绍地图二进制协议解析与点云渲染方面做过哪些工作？');const active=await chat.scan();assert.equal(active.state,'REPLY_NEEDED');
    const plan=await chat.prepare(active.id);assert(plan.content.includes(mapFact));assert(plan.factIds.every(id=>store.resume().facts.some(fact=>fact.id===id&&fact.approved)));assert(plan.blocks.some(block=>block.code==='CONSENT_REQUIRED'));assert.throws(()=>chat.commit(plan.id,false),{code:'GUI_AUTH_REQUIRED'});
    current=snapshot('anonymous_unknown','你有 SwiftUI 多年商业项目开发经验吗？');const unknown=await chat.scan();assert.equal(unknown.state,'REPLY_NEEDED');await assert.rejects(chat.prepare(unknown.id),(error:unknown)=>error instanceof AppError&&error.code==='CHAT_REVIEW_REQUIRED');assert.equal(chat.list().items.find(row=>row.id===unknown.id)?.state,'REVIEW');
    current=snapshot('anonymous_contact','方便提供手机号码和微信吗？');assert.equal((await chat.scan()).state,'REVIEW');
    assert.equal(writes,0);assert.equal(sender.outbox().total,0);assert.equal(chat.outbox().items.length,0);assert.equal(sender.policy().liveEnabled,false);assert.equal(chat.list().autoEnabled,false);
    const report={checkedAt:new Date().toISOString(),result:'PASS',provider:live?'live Cockpit':'anonymous HTTP fixture',model:config.model,data:'synthetic facts and questions only',realBossAccess:false,waiting:'WAITING',refused:'REJECTED',question:'fact-bound draft',unsupportedExperience:'REVIEW',contactRequest:'REVIEW',draftLength:[...plan.content].length,liveEnabled:false,guiGuard:true,browserWrites:0,firstContactIntents:0,replyIntents:0,realMessagesSent:0};
    await mkdir('.local/qa',{recursive:true});await writeFile(join('.local/qa',live?'m3.2-live-chat-smoke.json':'m3.2-chat-smoke.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
  }finally{await chat.close();await sender.close();store.close();await rm(dir,{recursive:true,force:true});}
}
if(live){
  const root=runtimePaths().root,status=await callWorker(root,'status');assert(status.ok,status.error?.code??'WORKER_ERROR');
  const path=(status.data as {llm:{envPath:string}}).llm.envPath;
  await smoke(readEnvironment(path).configuration);
}else await withModel(body=>{
  const input=JSON.parse(body.messages[1].content);
  return input.question.includes('SwiftUI')?{decision:'review',factIds:[]}:{decision:'reply',factIds:[input.facts.find((fact:{text:string})=>fact.text===mapFact).id]};
},config=>smoke(config));
