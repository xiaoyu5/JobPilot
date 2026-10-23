import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
test('reader publishes visible contacts before any conversation is selected and native isolation can locate one without a manual first click',async()=>{
 execFileSync(process.execPath,['scripts/build-boss-reader.mjs']);
 const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
  const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="nav-figure"><span class="label-text">匿名</span></div><aside class="chat-user"><div class="user-list"><div class="friend-content"><span class="name-text">匿名招聘人</span></div></div></aside>'}));await page.goto('https://www.zhipin.com/web/geek/chat');
  await page.evaluate(()=>{const node=document.querySelector('.friend-content') as any;node.__vue__={$props:{source:{name:'匿名招聘人',uid:123456789}}};node.onclick=()=>{document.body.insertAdjacentHTML('beforeend','<section class="chat-conversation" data-boss-id="123456789"><span class="boss-name">匿名招聘人</span><div data-history-complete="true"></div><div class="message-item item-friend" data-mid="server_inbound"><span class="text">您好</span></div></section>');};});
  await page.evaluate(await readFile('.local/boss-reader/bridge.js','utf8'));
  const client=await page.context().newCDPSession(page),tree=await client.send('Page.getFrameTree'),world=await client.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'anonymous-native-reader'});
  const source=await readFile('dist/worker/browser-snapshot.js','utf8'),read=async()=>{const result=await client.send('Runtime.evaluate',{expression:source,contextId:world.executionContextId,returnByValue:true});assert(!result.exceptionDetails);return JSON.parse(result.result.value);};
  const empty=await read();assert.equal(empty.readerConnected,true);assert.equal(empty.conversation,null);assert.equal(empty.chatTargets.length,1);
  const actions=await readFile('dist/worker/browser-actions.js','utf8');const result=JSON.parse(await page.evaluate(actions.replace('__JOBPILOT_INPUT__',JSON.stringify({operation:'chat-open',purpose:'reply',jobId:'',recruiterId:'123456789',content:'',intentId:'read-only',deadline:Date.now()+3000}))) as string);assert.equal(result.data.opened,true);assert.equal((await read()).conversation.identityBound,true);
  await page.evaluate(()=>{(window as any).__JobPilotReadonlyBridge_v1__.stop();});assert.equal((await read()).readerConnected,false);
 }finally{await browser.close();}
});
