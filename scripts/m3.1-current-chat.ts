import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {callWorker} from '../packages/worker/src/client.js';
import {runtimePaths} from '../packages/worker/src/paths.js';
import {classifyConversation} from '../packages/core/src/chatting.js';

// Verification only: no navigation, model, composer write, send or consent change.
const root=runtimePaths().root;
async function call(action:Parameters<typeof callWorker>[1]){const response=await callWorker(root,action,undefined,30000);assert(response.ok,response.error?.code??'WORKER_ERROR');return response.data as any;}
const sending=await call('send.status'),chats=await call('chat.list');
assert.equal(sending.policy.liveEnabled,false);assert.equal(sending.autoModeConsent,false);assert.equal(sending.activeRunId,null);assert.equal(chats.autoEnabled,false);assert.equal(chats.busy,false);
// Route reads through the App's already authorized Apple Events identity.
const login=await call('boss.login.status');assert.equal(login.state,'LOGGED_IN');
const scanned=await call('chat.scan');
const db=new DatabaseSync(`${root}/jobpilot.sqlite`,{readOnly:true});
const persisted=db.prepare('SELECT snapshot_json FROM chat_conversations WHERE id=?').get(scanned.id);db.close();assert(persisted);
const current=JSON.parse(String(persisted.snapshot_json)),classification=classifyConversation(current);assert.equal(scanned.state,classification.state);
const report={checkedAt:new Date().toISOString(),login:login.state,imported:true,state:scanned.state,reason:classification.reason,identityBound:current.identityBound,historyComplete:current.historyComplete,messageCount:current.messages.length,incoming:current.messages.filter((m:any)=>m.direction==='incoming').length,outgoingDirection:current.messages.filter((m:any)=>m.direction==='outgoing').length,system:current.messages.filter((m:any)=>m.direction==='system').length,confirmed:current.messages.every((m:any)=>m.confirmed),liveEnabled:false,firstContactAuto:false,chatAuto:false,firstContactIntents:(await call('send.outbox')).total,replyIntents:(await call('chat.outbox')).items.length};
assert.equal(report.firstContactIntents,0);assert.equal(report.replyIntents,0);
await writeFile('.local/qa/m3.1-current-chat.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
