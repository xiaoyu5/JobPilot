import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const url='https://www.zhipin.com/job_detail/fixture_job.html';
const html=(editor=true)=>`<!doctype html><meta charset="utf-8"><div class="nav-figure"><span class="label-text">匿名用户</span></div><main class="job-detail" data-boss-id="fixture_boss"><h1 class="job-name">匿名 iOS 岗位</h1><div class="job-description">匿名 Swift 与地图岗位</div>${editor?'<div class="greet-dialog"><textarea></textarea><button class="btn-send">发送</button></div>':'<button class="instant">立即沟通</button>'}</main><script>window.localSendCount=0;document.querySelector('button').onclick=()=>{window.localSendCount++;if(document.querySelector('textarea')){const node=document.createElement('div');node.className='message-item is-self';node.dataset.messageId='server_fixture_123';const span=document.createElement('span');span.className='text';span.textContent=document.querySelector('textarea').value;node.append(span);document.querySelector('main').append(node);}};</script>`;
const content='您好，对贵司的岗位方向很感兴趣。在匿名项目中负责地图协议解析与点云渲染，期待进一步交流。';

test('browser action fixture binds target and draft, submits once, and verifies only an exact confirmed outgoing message',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
  try{
    const page=await browser.newPage();await page.route(url,route=>route.fulfill({contentType:'text/html',body:html()}));await page.goto(url);
    const source=await readFile('dist/worker/browser-actions.js','utf8');assert(source.length<256*1024);
    const call=(operation:string,extra:object={})=>page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify({operation,jobId:'fixture_job',recruiterId:'fixture_boss',content,intentId:'intent-fixture',deadline:Date.now()+5000,...extra}))) as Promise<any>;
    let result=JSON.parse(await call('prepare',{recruiterId:'wrong_boss'}));assert.equal(result.code,'TARGET_MISMATCH');assert.equal(await page.locator('textarea').inputValue(),'');
    result=JSON.parse(await call('prepare',{deadline:Date.now()-1}));assert.equal(result.code,'ACTION_EXPIRED');
    result=JSON.parse(await call('prepare'));assert.equal(result.data.prepared,true);assert.equal(await page.evaluate('window.localSendCount'),0);
    result=JSON.parse(await call('submit',{content:content+'改变'}));assert.equal(result.code,'DRAFT_CHANGED');assert.equal(await page.evaluate('window.localSendCount'),0);
    result=JSON.parse(await call('submit'));assert.equal(result.data.submitted,true);assert.equal(await page.evaluate('window.localSendCount'),1);
    result=JSON.parse(await call('verify'));assert.equal(result.data.state,'CONFIRMED');assert.equal(result.data.messageId,'server_fixture_123');assert(!JSON.stringify(result).includes(content));
    await call('submit');assert.equal(await page.evaluate('window.localSendCount'),1);
    await page.locator('.message-item').evaluate(node=>node.classList.add('sending'));result=JSON.parse(await call('verify'));assert.equal(result.data.state,'UNKNOWN');
  }finally{await browser.close();}
});

test('unknown instant-contact entry and security challenge never trigger a page click',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
  try{
    const page=await browser.newPage();await page.route(url,route=>route.fulfill({contentType:'text/html',body:html(false)}));await page.goto(url);
    const source=await readFile('dist/worker/browser-actions.js','utf8');const input={operation:'prepare',jobId:'fixture_job',recruiterId:'fixture_boss',content,intentId:'intent-fixture',deadline:Date.now()+5000};
    const result=JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify(input))));assert.equal(result.code,'ADAPTER_CHANGED');assert.equal(await page.evaluate('window.localSendCount'),0);
    await page.evaluate(()=>{const challenge=document.createElement('div');challenge.className='geetest_panel';challenge.textContent='安全验证';document.body.append(challenge);});
    const blocked=JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify(input))));assert.equal(blocked.code,'BOSS_CHALLENGE');assert.equal(await page.evaluate('window.localSendCount'),0);
  }finally{await browser.close();}
});

const firstContactHtml=`<!doctype html><meta charset="utf-8"><div class="nav-figure"><span class="label-text">匿名用户</span></div><div class="job-banner" data-boss-id="fixture_boss"><button id="instant">立即沟通</button></div><main class="job-detail"><h1 class="job-name">匿名岗位</h1><div class="job-description">匿名 JD</div></main><script>
window.defaults=0;window.aiReplies=0;
document.querySelector('#instant').onclick=()=>{window.defaults++;document.querySelector('#instant').textContent='继续沟通';document.querySelector('main').insertAdjacentHTML('beforeend','<section class="chat-conversation" data-boss-id="fixture_boss" data-job-id="fixture_job"><b class="boss-name">匿名招聘人</b><div class="history-start" data-history-complete="true">没有更多消息</div><div class="message-item is-self" data-message-id="default_server_1"><span class="text">平台默认招呼</span></div><div class="message-item item-friend" data-mid="platform_pk_card"><h3 class="message-card-top-title">你与该职位竞争者PK情况</h3></div><div id="chat-input" contenteditable="true"></div><small>按Enter键发送，按Ctrl+Enter键换行</small></section>');document.querySelector('#chat-input').onkeydown=e=>{if(e.key==='Enter'){window.aiReplies++;const input=document.querySelector('#chat-input');input.insertAdjacentHTML('beforebegin','<div class="message-item is-self" data-message-id="ai_server_'+window.aiReplies+'"><span class="text"></span></div>');input.previousElementSibling.querySelector('.text').textContent=input.textContent;input.textContent='';}};};</script>`;

test('known immediate contact is a sending action: one platform default, then one explicitly confirmed AI text via the visible Enter hint',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
    const page=await browser.newPage();await page.route(url,route=>route.fulfill({contentType:'text/html',body:firstContactHtml}));await page.goto(url);const source=await readFile('dist/worker/browser-actions.js','utf8');
    const call=async(operation:string,extra:object={})=>JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify({operation,jobId:'fixture_job',recruiterId:'fixture_boss',content,intentId:'two-message-intent',deadline:Date.now()+5000,...extra}))) as string);
    assert.equal((await call('prepare')).code,'ADAPTER_CHANGED');assert.equal(await page.evaluate('window.defaults'),0);
    assert.equal((await call('contact-submit')).code,'CONSENT_REQUIRED');assert.equal(await page.evaluate('window.defaults'),0);
    assert.equal((await call('contact-submit',{purpose:'default-then-ai'})).data.submitted,true);assert.equal(await page.evaluate('window.defaults'),1);
    assert.equal((await call('contact-verify')).data.messageId,'default_server_1');
    assert.equal((await call('prepare',{purpose:'first-contact-ai',initialMessageId:'default_server_1'})).data.prepared,true);assert.equal(await page.evaluate('window.aiReplies'),0);
    assert.equal((await call('submit',{purpose:'first-contact-ai',initialMessageId:'default_server_1'})).data.submitted,true);assert.equal(await page.evaluate('window.aiReplies'),1);assert.equal((await call('verify')).data.state,'CONFIRMED');
    assert.equal((await call('contact-submit',{purpose:'default-then-ai'})).code,'ALREADY_CONTACTED');assert.equal(await page.evaluate('window.defaults'),1);
  }finally{await browser.close();}
});

test('selected conversation excludes sidebar refusals, binds latest inbound, and blocks refusal arriving before reply',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
    const page=await browser.newPage();await page.route(url,route=>route.fulfill({contentType:'text/html',body:firstContactHtml}));await page.goto(url);const source=await readFile('dist/worker/browser-actions.js','utf8');
    const call=async(operation:string,extra:object={})=>JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify({operation,jobId:'fixture_job',recruiterId:'fixture_boss',content,intentId:'chat-reply-intent',deadline:Date.now()+5000,...extra}))) as string);
    await call('contact-submit',{purpose:'default-then-ai'});await page.evaluate(()=>{const container=document.createElement('div');container.className='chat-message';const item=document.querySelector('.chat-conversation .message-item')!;item.replaceWith(container);container.append(item);document.body.insertAdjacentHTML('afterbegin','<aside class="chat-user"><div class="chat-content"><div class="message-item">不合适，谢谢</div></div></aside>');document.querySelector('.chat-conversation')!.insertAdjacentHTML('beforeend','<div class="message-item is-self" data-message-id="my_old_1"><span class="text">我目前不考虑外包岗位</span></div><div class="message-item" data-message-id="incoming_new_1"><span class="text">做过地图吗？</span></div>');});
    assert.equal((await call('prepare',{purpose:'reply',expectedInboundId:'older_message'})).code,'CONVERSATION_CHANGED');
    assert.equal((await call('prepare',{purpose:'reply',expectedInboundId:'incoming_new_1'})).data.prepared,true);
    await page.evaluate(()=>document.querySelector('.chat-conversation')!.insertAdjacentHTML('beforeend','<div class="message-item" data-message-id="incoming_refusal"><span class="text">不太合适，谢谢</span></div>'));
    assert.equal((await call('submit',{purpose:'reply',expectedInboundId:'incoming_new_1'})).code,'CONVERSATION_REJECTED');assert.equal(await page.evaluate('window.aiReplies'),0);
  }finally{await browser.close();}
});

test('rendered metadata accepts only the URL-bound job identifiers and never traverses auth fields',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
    const page=await browser.newPage();await page.route(url,route=>route.fulfill({contentType:'text/html',body:html()}));await page.goto(url);const source=await readFile('dist/worker/browser-actions.js','utf8');
    await page.evaluate(()=>{const root=document.querySelector('.job-detail')!;root.removeAttribute('data-boss-id');const data={jobInfo:{encryptJobId:'fixture_job',encryptBossId:'fixture_boss'}};Object.defineProperty(data,'securityId',{get(){throw new Error('must not read auth');}});(root as any).__vue__={$data:data};});
    const input={operation:'prepare',jobId:'fixture_job',recruiterId:'fixture_boss',content,intentId:'metadata-intent',deadline:Date.now()+5000};
    assert.equal(JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify(input))) as string).data.prepared,true);
    await page.evaluate(()=>{(document.querySelector('.job-detail') as any).__vue__.$data.jobInfo.encryptJobId='another_job';});
    assert.equal(JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify(input))) as string).code,'TARGET_MISMATCH');
  }finally{await browser.close();}
});

test('reply proof excludes identical historical text and a verified composer can answer a later inbound exactly once',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
    const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="nav-figure"><span class="label-text">匿名用户</span></div><section class="chat-conversation" data-boss-id="fixture_boss" data-job-id="fixture_job"><div data-history-complete="true">没有更多消息</div><div id="messages"><li class="message-item item-myself" data-mid="older_out"><span class="text"></span></li><li class="message-item item-friend" data-mid="inbound_1"><span class="text">做过地图吗？</span></li></div><textarea></textarea><button class="btn-send">发送</button></section>'}));await page.goto(url);
    await page.evaluate(text=>{document.querySelector('.message-item .text')!.textContent=text;(window as any).sendCount=0;document.querySelector('button')!.onclick=()=>{const field=document.querySelector('textarea')!;const item=document.createElement('li');item.className='message-item item-myself';item.setAttribute('data-mid','new_out_'+(++(window as any).sendCount));const body=document.createElement('div');body.className='text';body.innerHTML='<i class="message-status status-read">已读</i><p><span class="text-content"></span></p>';body.querySelector('.text-content')!.textContent=field.value;item.append(body);document.querySelector('#messages')!.append(item);field.value='';};},content);
    const source=await readFile('dist/worker/browser-actions.js','utf8');
    const call=async(operation:string,extra:object={})=>JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify({operation,jobId:'fixture_job',recruiterId:'fixture_boss',content,intentId:'reply_1',purpose:'reply',expectedInboundId:'inbound_1',deadline:Date.now()+5000,...extra}))) as string);
    assert.equal((await call('verify')).data.state,'UNKNOWN');assert.equal((await call('prepare')).data.prepared,true);assert.equal((await call('submit')).data.submitted,true);assert.equal((await call('verify')).data.messageId,'new_out_1');
    await page.evaluate(()=>document.querySelector('#messages')!.insertAdjacentHTML('beforeend','<li class="message-item item-friend" data-mid="inbound_2"><span class="text">能具体介绍一下吗？</span></li>'));
    assert.equal((await call('verify',{expectedInboundId:'inbound_2'})).data.state,'UNKNOWN');assert.equal((await call('prepare',{intentId:'reply_2',expectedInboundId:'inbound_2'})).data.prepared,true);assert.equal((await call('submit',{intentId:'reply_2',expectedInboundId:'inbound_2'})).data.submitted,true);assert.equal((await call('verify',{expectedInboundId:'inbound_2'})).data.messageId,'new_out_2');assert.equal(await page.evaluate('window.sendCount'),2);
    await call('submit',{intentId:'reply_2',expectedInboundId:'inbound_2'});assert.equal(await page.evaluate('window.sendCount'),2);
  }finally{await browser.close();}
});

test('official rendered chat redirect binds id only to the exact job and never follows the add-friend action or returns security values',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
    const page=await browser.newPage();let requests=0;await page.route('**/*',route=>{requests++;return route.fulfill({contentType:'text/html',body:html(false)});});await page.goto(url);
    await page.evaluate(()=>{const root=document.querySelector('.job-detail')!;root.removeAttribute('data-boss-id');root.insertAdjacentHTML('beforeend','<div class="more-job-section" data-boss-id="recommended_other_boss"></div>');const button=root.querySelector('button')!;button.setAttribute('data-url','/wapi/zpgeek/friend/add.json?securityId=private-canary&jobId=fixture_job');button.setAttribute('redirect-url','/web/geek/chat?id=fixture_boss&jobId=fixture_job&securityId=private-canary&lid=not-used');});
    const source=await readFile('dist/worker/browser-snapshot.js','utf8');let snapshot=JSON.parse(await page.evaluate(source) as string);assert.deepEqual(snapshot.communication.recruiterIds,['fixture_boss']);assert.equal(snapshot.communication.entryKind,'instant-send');assert(!JSON.stringify(snapshot).includes('private-canary'));assert.equal(requests,1);assert.equal(await page.evaluate('window.localSendCount'),0);
    for(const recruiter of ['opaque_hr~~','opaque_hr%7E%7E','unsafe%2Fpath','undefined']){
      await page.locator('button').evaluate((node,recruiter)=>node.setAttribute('redirect-url',`/web/geek/chat?id=${recruiter}&jobId=fixture_job`),recruiter);
      snapshot=JSON.parse(await page.evaluate(source) as string);assert.deepEqual(snapshot.communication.recruiterIds,recruiter.startsWith('opaque_hr')?['opaque_hr~~']:[]);
    }
    await page.locator('button').evaluate(node=>node.setAttribute('redirect-url','/web/geek/chat?id=wrong_boss&jobId=other_job'));
    snapshot=JSON.parse(await page.evaluate(source) as string);assert.deepEqual(snapshot.communication.recruiterIds,[]);assert.equal(requests,1);
  }finally{await browser.close();}
});

test('chat identity cannot come from a message hyperlink or a stale chat URL after changing contacts',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
    const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="nav-figure"><span class="label-text">匿名用户</span></div><section class="chat-conversation"><b class="boss-name">匿名招聘人</b><li class="message-item" data-mid="inbound_1"><span class="text">做过地图吗？</span><a href="/web/geek/chat?id=forged_boss">站内链接</a></li></section>'}));await page.goto('https://www.zhipin.com/web/geek/chat?id=stale_boss&jobId=fixture_job');
    const source=await readFile('dist/worker/browser-snapshot.js','utf8');let snapshot=JSON.parse(await page.evaluate(source) as string);assert.equal(snapshot.conversation.identityBound,false);assert.deepEqual(snapshot.communication.recruiterIds,[]);
    await page.locator('.chat-conversation').evaluate(node=>node.setAttribute('data-boss-id','current_boss'));snapshot=JSON.parse(await page.evaluate(source) as string);assert.equal(snapshot.conversation.identityBound,false);assert.deepEqual(snapshot.communication.recruiterIds,[]);
    await page.evaluate(()=>history.replaceState(null,'','/web/geek/chat?id=current_boss&jobId=fixture_job'));snapshot=JSON.parse(await page.evaluate(source) as string);assert.equal(snapshot.conversation.identityBound,true);assert.deepEqual(snapshot.communication.recruiterIds,['current_boss']);
  }finally{await browser.close();}
});
