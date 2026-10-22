import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {Store} from '@jobpilot/store';
import {Application} from '../packages/worker/src/application.js';
import {NotificationService,validateWebhook} from '../packages/worker/src/notifications.js';
import {readEnvironmentValues} from '../packages/worker/src/environment.js';
import {withModel,goodResponse} from './m2-fixtures.js';
import {seedSendQueue} from './m3-fixtures.js';

const webhook='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=anonymous-test-key';
const preferences={enabled:true,queueReview:true,chatReview:true,taskAttention:true};
const response=()=>new Response(JSON.stringify({errcode:0,errmsg:'ok'}));
function chat(store:Store,id:string,state:string,inbound:string|null='question-1'){
  store.db.prepare('INSERT INTO chat_conversations(id,recruiter_id,name,company,state,reason,snapshot_json,last_inbound_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,id,'匿名联系人','匿名公司',state,'匿名原因',JSON.stringify({messages:[{id:inbound,text:'private question',direction:'incoming'}],capturedAt:new Date().toISOString()}),inbound,new Date().toISOString());
}

test('WeCom URL is HTTPS, host/path/key restricted; redirects and alternate endpoints cannot receive a key',()=>{
  assert.equal(validateWebhook(webhook),webhook);
  for(const bad of [webhook.replace('https:','http:'),webhook.replace('qyapi.weixin.qq.com','qyapi.weixin.qq.com.evil.example'),webhook.replace('/send?','/upload_media?'),webhook+'&key=otherkey',webhook+'&next=https://example.com',webhook+'#fragment',webhook.replace('https://','https://user:pass@'),webhook.replace('.com/','.com:8443/'),webhook.replace('anonymous-test-key','bad%0Akey')])assert.throws(()=>validateWebhook(bad),{code:'NOTIFICATION_URL_INVALID'});
});

test('GUI-only configuration preserves LLM env; keys stay outside status, database and test bodies; test does not grant BOSS sends',async()=>{
  const dir=await mkdtemp('/tmp/jp-notify-config-'),calls:{url:string;options:RequestInit}[]=[];
  const app=new Application(dir,{notifications:{fetch:async(url,options)=>{calls.push({url:String(url),options:options!});return response();}}}),signal=new AbortController().signal;
  try{
    await writeFile(`${dir}/.env`,'# retained\nOPENAI_API_KEY="private-llm-fixture"\nWECOM_WEBHOOK_URL=""\nHOOK_URL="'+webhook+'"\n',{mode:0o600});
    const before=JSON.stringify(app.sending.status());
    for(const action of ['notifications.save','notifications.test','notifications.check'] as const)await assert.rejects(app.dispatch(action,preferences,signal),{code:'GUI_AUTH_REQUIRED'});
    assert.equal(app.notifications.status().settings.enabled,false);assert.equal(app.notifications.status().configured,true);assert.equal(calls.length,0);
    const configured=await app.dispatch('notifications.save',{...preferences,webhookUrl:webhook},signal,true);
    assert(!JSON.stringify(configured).includes('anonymous-test-key'));
    assert.equal(readEnvironmentValues(`${dir}/.env`).OPENAI_API_KEY,'private-llm-fixture');assert((await readFile(`${dir}/.env`,'utf8')).includes('# retained'));assert.equal((await stat(`${dir}/.env`)).mode&0o777,0o600);
    await app.dispatch('notifications.test',undefined,signal,true);assert.equal(calls.length,1);assert.equal(calls[0].url,webhook);assert.equal(calls[0].options.redirect,'error');
    const body=JSON.parse(String(calls[0].options.body));assert.equal(body.msgtype,'text');assert(body.text.content.includes('测试通知'));assert(!String(calls[0].options.body).includes('private-llm-fixture'));
    assert.equal(JSON.stringify(app.sending.status()),before);assert.equal(app.chatting.list().autoEnabled,false);assert.equal(app.sending.outbox().total,0);
    await assert.rejects(app.notifications.test(true),{code:'NOTIFICATION_RATE_LIMIT'});
    await assert.rejects(app.dispatch('notifications.save',{...preferences,clearWebhook:true},signal,true),{code:'NOTIFICATION_NOT_CONFIGURED'});
    await app.dispatch('notifications.save',{...preferences,enabled:false,clearWebhook:true},signal,true);assert.equal(app.notifications.status().configured,false);assert.equal(readEnvironmentValues(`${dir}/.env`).HOOK_URL,'');
    app.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const db=await readFile(`${dir}/jobpilot.sqlite`);assert(!db.includes(Buffer.from('anonymous-test-key')));assert(!db.includes(Buffer.from('private-llm-fixture')));
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('real queue lifecycle aggregates BOSS-only review work, suppresses reviewed items and deduplicates across scans/restarts',async()=>withModel(goodResponse,async config=>{
  const dir=await mkdtemp('/tmp/jp-notify-queue-'),store=new Store(dir);let now=Date.now(),calls:string[]=[],service:NotificationService|undefined;
  const make=()=>new NotificationService(store,()=>`${dir}/.env`,()=>false,()=>[],{clock:()=>now,fetch:async(_url,options)=>{calls.push(String(options?.body));return response();}});
  try{
    const items=await seedSendQueue(store,config,2),queueId=items[0].queueId;
    // Normal draft editing revokes its previous review.
    const {MatchingService}=await import('@jobpilot/core');const matching=new MatchingService(store,()=>config);
    matching.updateDraft(items[0].draft.id,items[0].draft.version,items[0].draft.content);
    service=make();service.save({...preferences,webhookUrl:webhook},true);const first=await service.check();
    assert.equal(first.pending.queue,1);assert.equal(calls.length,1);assert(calls[0].includes('首联草稿待审核：1'));assert(!calls[0].includes('Welgoo'));assert(!calls[0].includes(items[0].draft.content));
    now+=61000;await service.check();assert.equal(calls.length,1);await service.close();service=make();await service.check();assert.equal(calls.length,1);
    // Stale draft is a distinct reason for attention, while a read/version bump is not.
    store.db.prepare("UPDATE review_queue SET state='STALE',version=version+1 WHERE id=?").run(queueId);await service.check();assert.equal(calls.length,2);
    now+=61000;store.db.prepare('UPDATE review_queue SET version=version+1 WHERE id=?').run(queueId);await service.check();assert.equal(calls.length,2);
    store.db.prepare("UPDATE review_queue SET state='REVIEWED' WHERE id=?").run(queueId);assert.equal((await service.check()).pending.queue,0);
    // Anonymous demo queues are excluded even if locally pending.
    store.db.prepare("UPDATE jobs SET source='demo' WHERE id=?").run(items[1].job.id);store.db.prepare("UPDATE review_queue SET state='PENDING' WHERE id=?").run(items[1].queueId);await service.check();assert.equal(calls.length,2);
    assert.equal(store.db.prepare('SELECT count(*) n FROM send_outbox').get()!.n,0);
  }finally{await service?.close();store.close();await rm(dir,{recursive:true,force:true});}
}));

test('new inbound questions and manual handoff notify, refusals/waiting/authorized automatic replies do not',async()=>{
  const dir=await mkdtemp('/tmp/jp-notify-chat-'),store=new Store(dir);let now=Date.now(),calls=0;
  const service=new NotificationService(store,()=>`${dir}/.env`,()=>false,()=>['auto-chat'],{clock:()=>now,fetch:async()=>{calls++;return response();}});
  try{
    for(const [id,state] of [['refused','REJECTED'],['waiting','WAITING'],['auto-chat','REPLY_NEEDED'],['manual','REVIEW'],['question','REPLY_NEEDED']] as const)chat(store,id,state);
    service.save({...preferences,webhookUrl:webhook},true);assert.equal((await service.check()).pending.chats,2);assert.equal(calls,1);
    now+=61000;store.db.prepare('UPDATE chat_conversations SET version=version+1,updated_at=?').run(new Date(now).toISOString());await service.check();assert.equal(calls,1);
    store.db.prepare("UPDATE chat_conversations SET last_inbound_id='question-2' WHERE id='question'").run();await service.check();assert.equal(calls,2);
    now+=61000;store.db.prepare("UPDATE chat_conversations SET state='REJECTED' WHERE id IN ('manual','question')").run();assert.equal((await service.check()).pending.chats,0);assert.equal(calls,2);
    store.db.prepare("UPDATE chat_conversations SET state='REVIEW' WHERE id='auto-chat'").run();assert.equal((await service.check()).pending.chats,1);assert.equal(calls,3);
  }finally{await service.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('unknown send result and human-needed runs notify without changing or retrying BOSS outboxes',async()=>{
  const dir=await mkdtemp('/tmp/jp-notify-verify-'),store=new Store(dir);let body='';
  const service=new NotificationService(store,()=>`${dir}/.env`,()=>false,()=>[],{fetch:async(_url,options)=>{body=String(options?.body);return response();}});
  try{
    const run=store.createRun('boss');store.finishRun(run.id,'NEEDS_HUMAN','BOSS_LOGIN_REQUIRED');const verifyRun=store.createRun('boss');store.db.prepare("UPDATE runs SET kind='chat' WHERE id=?").run(verifyRun.id);store.finishRun(verifyRun.id,'NEEDS_HUMAN','NEEDS_VERIFY');
    store.db.prepare("INSERT INTO chat_outbox(id,run_id,conversation_id,recruiter_id,inbound_id,content,context_hash,state,created_at) VALUES(?,?,?,?,?,?,?,'NEEDS_VERIFY',?)").run(randomUUID(),verifyRun.id,'private-chat','private-boss','private-inbound','private-chat-body','context',new Date().toISOString());
    service.save({...preferences,webhookUrl:webhook},true);const before=store.db.prepare('SELECT * FROM chat_outbox').all();const result=await service.check();
    assert.equal(result.pending.verification,1);assert.equal(result.pending.tasks,1);assert(body.includes('发送结果待核验：1'));assert(!body.includes('private-chat'));assert.deepEqual(store.db.prepare('SELECT * FROM chat_outbox').all(),before);
    const recovered=store.createRun('boss');store.finishRun(recovered.id,'COMPLETED');assert.equal(service.status().pending.tasks,0);
  }finally{await service.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('HTTP/API/network errors are masked, bounded retries back off, destination changes require save, and disabled stays quiet',async()=>{
  const dir=await mkdtemp('/tmp/jp-notify-retry-'),store=new Store(dir);let now=Date.now(),calls=0,ok=false;
  const service=new NotificationService(store,()=>`${dir}/.env`,()=>false,()=>[],{clock:()=>now,fetch:async()=>{calls++;if(ok)return response();if(calls===1)return new Response('private-url',{status:503});if(calls===2)return new Response(JSON.stringify({errcode:93000,errmsg:webhook}));throw new Error(webhook);}});
  try{
    chat(store,'review','REVIEW');service.save({...preferences,webhookUrl:webhook},true);
    assert((await service.check()).lastError?.includes('HTTP 503'));await service.check();assert.equal(calls,1);
    now+=61000;assert((await service.check()).lastError?.includes('93000'));now+=121000;await service.check();assert.equal(calls,3);assert(!JSON.stringify(service.status()).includes('anonymous-test-key'));
    now+=900000;await service.check();assert.equal(calls,3);ok=true;await service.check(true,true);assert.equal(calls,4);assert.equal(service.status().lastError,null);
    now+=61000;await writeFile(`${dir}/.env`,'WECOM_WEBHOOK_URL="'+webhook.replace('anonymous-test-key','another-test-key')+'"\n');assert(service.status().error?.includes('已变化'));await service.check();assert.equal(calls,4);
    service.save({...preferences,enabled:false},true);await service.check();assert.equal(calls,4);
    service.save(preferences,true);await service.check();assert.equal(calls,5);
  }finally{await service.close();store.close();await rm(dir,{recursive:true,force:true});}
});

test('timer batches changes; overlapping checks cannot double post; shutdown aborts cleanly before database closes',async()=>{
  const dir=await mkdtemp('/tmp/jp-notify-timer-'),store=new Store(dir);let calls=0,release:(()=>void)|undefined,suspended=true;
  const service=new NotificationService(store,()=>`${dir}/.env`,()=>suspended,()=>[],{intervalMs:10,fetch:async(_url,options)=>{calls++;await new Promise<void>((resolve,reject)=>{release=resolve;options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});return response();}});
  try{
    chat(store,'needs-human','REVIEW');service.save({...preferences,webhookUrl:webhook},true);service.start();await delay(30);assert.equal(calls,0);suspended=false;
    for(let i=0;i<100&&!calls;i++)await delay(5);assert.equal(calls,1);await service.check();assert.equal(calls,1);assert(service.status().busy);
    await service.close();release?.();assert.equal(service.status().lastDeliveredAt,null);assert.equal(service.status().lastError,null);
  }finally{await service.close();store.close();await rm(dir,{recursive:true,force:true});}
});
