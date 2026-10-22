import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';

test('connected contacts switch in place only after being individually observed; recycled or unknown identities are not clickable targets',async()=>{
  execFileSync(process.execPath,['scripts/build-boss-reader.mjs']);
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
    const page=await browser.newPage();let requests=0;
    await page.route('**/*',route=>{requests++;return route.fulfill({contentType:'text/html; charset=utf-8',body:`<div class="nav-figure"><span class="label-text">匿名用户</span></div><aside class="chat-user"><div class="user-list"><div class="friend-content" id="a"><span class="name-text">匿名甲</span></div><div class="friend-content" id="b"><span class="name-text">匿名乙</span></div><div class="friend-content" id="c"><span class="name-text">匿名丙</span></div></div></aside><section class="chat-conversation"><div class="top-info-content"><span class="name-text">匿名甲</span></div><div class="chat-record"><li class="message-item item-myself" data-mid="confirmed_1"><span class="text">平台招呼</span></li></div><textarea></textarea><button class="btn-send">发送</button></section>`});});
    await page.goto('https://www.zhipin.com/web/geek/chat');
    await page.evaluate(()=>{
      const record=document.querySelector('.chat-record') as any;
      const bosses=[{name:'匿名甲',uid:123456789},{name:'匿名乙',uid:234567891},{name:'匿名丙',uid:345678912}];
      record.__vue__={$data:{boss:bosses[0],history:false,loading:false,isToTop:true,msgMinId:101}};
      for(const [index,id] of ['a','b','c'].entries()){
        const node=document.getElementById(id) as any;node.__vue__={$props:{source:bosses[index]}};
        Object.defineProperty(bosses[index],'securityId',{get(){throw new Error('Credentials must not be read');}});
        node.onclick=()=>{record.__vue__.$data.boss=node.__vue__.$props.source;document.querySelector('.top-info-content .name-text')!.textContent=node.__vue__.$props.source.name;};
      }
      (window as any).sent=0;document.querySelector('button')!.onclick=()=>{(window as any).sent++;};
    });
    await page.evaluate(await readFile('.local/boss-reader/bridge.js','utf8'));
    assert.equal(await page.locator('#a').getAttribute('data-boss-id'),'123456789');assert.equal(await page.locator('#b').getAttribute('data-boss-id'),null);
    await page.locator('#b').click();await page.waitForFunction(()=>document.querySelector('.chat-conversation')?.getAttribute('data-boss-id')==='234567891');
    assert.equal(await page.locator('#a').getAttribute('data-boss-id'),'123456789');assert.equal(await page.locator('#b').getAttribute('data-boss-id'),'234567891');assert.equal(await page.locator('#c').getAttribute('data-boss-id'),null);
    const source=await readFile('dist/worker/browser-actions.js','utf8');
    const open=async(recruiterId:string)=>JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify({operation:'chat-open',purpose:'reply',jobId:'',recruiterId,content:'',intentId:'read-only-fixture',deadline:Date.now()+3000}))) as string);
    assert.equal((await open('345678912')).code,'CHAT_NOT_VISIBLE');
    assert.equal((await open('123456789')).data.opened,true);await page.waitForFunction(()=>document.querySelector('.chat-conversation')?.getAttribute('data-boss-id')==='123456789');
    await page.locator('#b .name-text').evaluate(node=>node.textContent='姓名已变化');assert.equal((await open('234567891')).code,'CHAT_NOT_VISIBLE');
    await page.locator('#b').evaluate((node:any)=>{node.__vue__.$props.source={name:'姓名已变化',uid:456789123};});
    await page.waitForFunction(()=>!document.querySelector('#b')?.hasAttribute('data-boss-id'));
    assert.equal((await open('234567891')).code,'CHAT_NOT_VISIBLE');assert.equal(await page.evaluate('(window.sent)'),0);assert.equal(await page.locator('textarea').inputValue(),'');assert.equal(requests,1);
    await page.evaluate(()=>{(window as any).__JobPilotReadonlyBridge_v1__.stop();});assert.equal(await page.locator('#a').getAttribute('data-boss-id'),null);
  }finally{await browser.close();}
});
