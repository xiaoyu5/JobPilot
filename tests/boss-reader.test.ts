import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';

test('optional activeTab bridge exposes only current rendered business identity across Chrome isolated worlds and disconnect restores DOM',async()=>{
  execFileSync(process.execPath,['scripts/build-boss-reader.mjs']);
  const manifest=JSON.parse(await readFile('.local/boss-reader/manifest.json','utf8'));assert.deepEqual(manifest.permissions,['activeTab','scripting']);assert(!manifest.host_permissions&&!manifest.background&&!manifest.content_scripts);
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
    const page=await browser.newPage();const url='https://www.zhipin.com/web/geek/chat';
    await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<meta charset="utf-8"><div class="nav-figure"><span class="label-text">匿名用户</span></div><aside class="chat-user"><div class="chat-content">不合适</div></aside><section class="chat-conversation"><div class="top-info-content"><span class="name-text">匿名招聘人</span></div><div class="chat-record"><div class="chat-message"><li class="message-item item-myself" data-mid="server_1"><span class="text">您好</span></li><li class="message-item item-friend" data-mid="server_2"><div class="message-content"><h3 class="message-card-top-title">暂时不考虑</h3><p class="message-card-top-sub-title">谢谢关注</p></div></li></div></div></section>'}));await page.goto(url);
    await page.evaluate(()=>{const data={boss:{name:'匿名招聘人',encryptBossId:'',uid:123456789,encryptJobId:'fixture_job'}};Object.defineProperty(data,'securityId',{get(){throw new Error('Never read credentials');}});Object.defineProperty(data.boss,'securityId',{get(){throw new Error('Never read credentials');},enumerable:true});(document.querySelector('.chat-record') as any).__vue__={$props:data,$data:{hasMoreHistory:false}};window.fetch=()=>{throw new Error('No network');};});
    const client=await page.context().newCDPSession(page),tree=await client.send('Page.getFrameTree');const {executionContextId}=await client.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'anonymous-apple-events'});
    const source=await readFile('dist/worker/browser-snapshot.js','utf8');const read=async()=>{const r=await client.send('Runtime.evaluate',{expression:source,contextId:executionContextId,returnByValue:true});assert(!r.exceptionDetails);return JSON.parse(r.result.value);};
    assert.equal((await read()).conversation.identityBound,false);
    const connected=await page.evaluate(await readFile('.local/boss-reader/bridge.js','utf8')) as any;assert.equal(connected.chatIdentityPublished,true);assert(!JSON.stringify(connected).includes('fixture_hr'));
    assert.equal(await page.locator('.chat-conversation').getAttribute('data-jobpilot-reader-connected'),'true');assert(await page.locator('.jobpilot-readonly-indicator').innerText().then(text=>text.includes('已绑定')));
    const current=(await read()).conversation;assert.equal(current.recruiterId,'123456789');assert.equal(current.historyComplete,true);assert.equal(current.messages.length,2);assert.equal(current.messages[0].direction,'outgoing');assert(current.messages[1].text.includes('暂时不考虑'));
    await page.evaluate(()=>{(document.querySelector('.chat-record') as any).__vue__.$props.boss.encryptBossId='opaque_hr~~';history.replaceState(null,'','/web/geek/chat?id=opaque_hr%7E%7E&jobId=fixture_job');});
    await page.evaluate(await readFile('.local/boss-reader/bridge.js','utf8'));
    const aliased=(await read()).conversation;assert.equal(aliased.identityBound,true);assert.equal(aliased.recruiterId,'123456789');assert.deepEqual(aliased.recruiterAliases,['123456789','opaque_hr~~']);
    const actions=await readFile('dist/worker/browser-actions.js','utf8');const proof=JSON.parse(await page.evaluate(actions.replace('__JOBPILOT_INPUT__',JSON.stringify({operation:'contact-verify',jobId:'fixture_job',recruiterId:'opaque_hr~~',content:'',intentId:'fixture-read-only',deadline:Date.now()+3000}))) as string);assert.equal(proof.data.state,'UNKNOWN','a conversation with an inbound refusal is not a fresh default-only contact');
    // Real main chat-record shape: history=false alone is also the initial state.
    await page.evaluate(()=>{const record=document.querySelector('.chat-record') as any;record.__vue__.$data={boss:record.__vue__.$props.boss,history:false,loading:false,isToTop:false,msgMinId:0};});
    const reconnect=async()=>page.evaluate(await readFile('.local/boss-reader/bridge.js','utf8'));
    await reconnect();assert.equal((await read()).conversation.historyComplete,false);
    await page.evaluate(()=>{Object.assign((document.querySelector('.chat-record') as any).__vue__.$data,{isToTop:true,msgMinId:101});});
    await reconnect();assert.equal((await read()).conversation.historyComplete,true);
    for(const change of [{loading:true},{history:true},{isToTop:false},{msgMinId:0},{boss:{name:'另一个招聘人',uid:123456789}},{boss:{name:'匿名招聘人',uid:987654321}}]){
      await page.evaluate(change=>{const record=document.querySelector('.chat-record') as any;record.__vue__.$data={boss:record.__vue__.$props.boss,history:false,loading:false,isToTop:true,msgMinId:101,...change};},change);
      await reconnect();assert.equal((await read()).conversation.historyComplete,false);
    }
    await page.evaluate(()=>{(window as any).__JobPilotReadonlyBridge_v1__.stop();});assert.equal((await read()).conversation.identityBound,false);assert.equal(await page.locator('.chat-record').getAttribute('data-history-complete'),null);assert.equal(await page.locator('.jobpilot-readonly-indicator').count(),0);
  }finally{await browser.close();}
});
