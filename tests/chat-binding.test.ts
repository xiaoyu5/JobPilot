import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindConversation,requireChatConnection} from '../packages/boss-adapter/src/chat-binding.js';
import {NativeChrome} from '../packages/boss-adapter/src/native.js';
import type {ConversationSnapshot} from '@jobpilot/contracts';
const target:ConversationSnapshot={id:'boss-chat:opaque_hr',recruiterId:'opaque_hr',recruiterAliases:['opaque_hr','123456789'],jobId:'known_job',name:'匿名招聘人',company:'匿名公司',url:'https://www.zhipin.com/web/geek/chat',identityBound:true,historyComplete:true,messages:[],capturedAt:new Date().toISOString()};
test('read-only refresh recognizes only verified recruiter aliases and exact names; an expired bridge is not reported as a missing contact',async()=>{
 const current={...target,id:'boss-chat:123456789',recruiterId:'123456789',recruiterAliases:['123456789']};
 const bound=bindConversation(current,target);assert.equal(bound.id,target.id);assert.equal(bound.recruiterId,target.recruiterId);assert.deepEqual(bound.recruiterAliases,['opaque_hr','123456789']);
 for(const change of [{name:'同名以外的人'},{jobId:'other_job'},{recruiterId:'other_hr',recruiterAliases:[]},{identityBound:false}])assert.throws(()=>bindConversation({...current,...change},target),{code:'TARGET_MISMATCH'});
 assert.throws(()=>requireChatConnection({url:target.url,readerConnected:false}),{code:'CHAT_READER_REQUIRED'});
 assert.throws(()=>requireChatConnection({url:'https://www.zhipin.com/web/geek/jobs',readerConnected:false}),{code:'CHAT_PAGE_REQUIRED'});
 const browser=new NativeChrome('/tmp/anonymous-chat-binding') as any;let actions=0;
 browser.read=async()=>({state:'LOGGED_IN',url:target.url,readerConnected:true,conversation:current});browser.chatAction=async()=>{actions++;throw new Error('No contact click expected');};
 assert.equal((await browser.readConversation(new AbortController().signal,target)).id,target.id);assert.equal(actions,0);
 browser.read=async()=>({state:'LOGGED_IN',url:target.url,readerConnected:false,conversation:{...current,identityBound:false}});
 await assert.rejects(browser.readConversation(new AbortController().signal,target),{code:'CHAT_READER_REQUIRED'});assert.equal(actions,0);
});
