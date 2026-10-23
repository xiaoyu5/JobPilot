import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('remembered reader access is optional, gesture requested, narrowly registered and revocable; denial keeps activeTab-only mode',async()=>{
 const manifest=JSON.parse(await readFile('extensions/boss-reader/manifest.json','utf8'));assert.deepEqual(manifest.optional_host_permissions,['https://www.zhipin.com/*']);assert.equal(manifest.host_permissions,undefined);assert.equal(manifest.content_scripts,undefined);
 const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
  const page=await browser.newPage();await page.setContent(await readFile('extensions/boss-reader/popup.html','utf8'));await page.evaluate('globalThis.__name = value => value');await page.evaluate(()=>{
   const state=(window as any).fixture={allowed:false,requested:0,registered:[],executed:0,removed:0};
   (window as any).chrome={tabs:{query:async()=>[{id:42,url:'https://www.zhipin.com/web/geek/chat'}]},permissions:{request:async()=>{state.requested++;return state.allowed;},remove:async()=>{state.removed++;return true;}},scripting:{getRegisteredContentScripts:async()=>state.registered,registerContentScripts:async(scripts:any)=>{state.registered=scripts;},updateContentScripts:async(scripts:any)=>{state.registered=scripts;},unregisterContentScripts:async()=>{state.registered=[];},executeScript:async()=>{state.executed++;return [{result:{connected:true}}];}}};
  });await page.evaluate(await readFile('extensions/boss-reader/popup.js','utf8'));assert.equal(await page.evaluate('(window.fixture.requested)'),0);
  await page.locator('#remember').click();await page.getByText('未允许网站访问，仍可使用单次连接。',{exact:true}).waitFor();assert.equal(await page.evaluate('(window.fixture.registered.length)'),0);assert.equal(await page.evaluate('(window.fixture.executed)'),0);
  await page.locator('#connect').click();await page.waitForFunction(()=>(window as any).fixture.executed===1);
  await page.evaluate(()=>{(window as any).fixture.allowed=true;});await page.locator('#remember').click();await page.getByText('已记住只读连接；BOSS 消息和岗位页刷新、重启后自动启用。',{exact:true}).waitFor();
  const registration=await page.evaluate('(window.fixture.registered[0])') as {matches:string[];world:string;persistAcrossSessions:boolean;allFrames:boolean};assert.deepEqual(registration.matches,['https://www.zhipin.com/web/geek/chat*','https://www.zhipin.com/job_detail/*']);assert.equal(registration.world,'MAIN');assert.equal(registration.persistAcrossSessions,true);assert.equal(registration.allFrames,false);
  await page.locator('#stop').click();await page.getByText('已断开并移除当前标记，自动连接和 BOSS 网站授权已关闭。',{exact:true}).waitFor();assert.equal(await page.evaluate('(window.fixture.registered.length)'),0);assert.equal(await page.evaluate('(window.fixture.removed)'),1);
 }finally{await browser.close();}
});
