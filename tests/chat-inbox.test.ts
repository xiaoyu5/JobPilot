import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Store} from '@jobpilot/store';
import {MatchingService} from '@jobpilot/core';
import {ChattingService} from '../packages/core/src/chatting.js';
import {SendingService} from '../packages/core/src/sending.js';
import {prepare,withModel,goodResponse} from './m2-fixtures.js';
import type {ConversationSnapshot} from '@jobpilot/contracts';
test('inbox discovery imports new contacts without granting Auto, persists rejection and stops monitoring on emergency stop',async()=>{
 await withModel(goodResponse,async config=>{
  const dir=await mkdtemp('/tmp/jp-inbox-'),store=new Store(dir);prepare(store,config);store.updateConfig({bossReadOnlyConsent:true});
  const sending=new SendingService(store,new MatchingService(store,()=>config),{} as any,async()=>true);
  const targets=[{recruiterId:'reject_hr',name:'拒绝联系人',company:'匿名公司'},{recruiterId:'new_hr',name:'新联系人',company:'匿名公司'}];
  let rejected=true;
  const service=new ChattingService(store,sending,{discoverConversations:async()=>targets,readConversation:async(_signal,target)=>({...target!,identityBound:true,historyComplete:true,messages:[{id:'server_inbound',direction:'incoming',text:target!.recruiterId==='reject_hr'&&rejected?'暂不考虑，谢谢':'做过地图项目吗？',confirmed:true}]} as ConversationSnapshot),prepareReply:async()=>assert.fail('must not edit'),submitReply:async()=>assert.fail('must not send'),verifyReply:async()=>assert.fail('must not verify')},()=>config);
  try{
   const scan=await service.scanInbox();assert.equal(scan.scanned,2);assert.deepEqual(scan.items.map(row=>row.state),['REJECTED','REPLY_NEEDED']);assert.equal(service.list().autoEnabled,false);assert.deepEqual(service.list().authorizedIds,[]);
   rejected=false;assert.equal((await service.scanInbox()).items[0].state,'REJECTED');
   assert.throws(()=>service.setWatch(true,false),/应用界面/);service.setWatch(true,true);assert.equal(service.list().watchEnabled,true);service.stop();assert.equal(service.list().watchEnabled,false);assert.equal(store.db.prepare('SELECT count(*) n FROM chat_outbox').get()!.n,0);
  }finally{await service.close();await sending.close();store.close();await rm(dir,{recursive:true,force:true});}
 });
});
