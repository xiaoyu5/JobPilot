import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
test('read-only history scroll and search pagination never write a composer or click a communication button; unknown targets and changed filters stop',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="nav-figure"><span class="label-text">匿名</span></div><section class="chat-conversation" data-boss-id="known_hr"><span class="boss-name">匿名招聘人</span><div class="chat-record" style="height:50px;overflow:auto"><div style="height:300px">旧消息</div></div><textarea>保留人工输入</textarea><button class="btn-send">发送</button></section>'}));await page.goto('https://www.zhipin.com/web/geek/chat');
  const source=await readFile('dist/worker/browser-actions.js','utf8'),call=async(operation:string,recruiterId='known_hr')=>JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify({operation,purpose:'reply',recruiterId,jobId:'',content:'',intentId:'readonly-fixture',deadline:Date.now()+3000}))) as string);
  await page.evaluate(()=>{(window as any).sends=0;document.querySelector('button')!.onclick=()=>{(window as any).sends++;};document.querySelector('.chat-record')!.scrollTop=200;});assert.equal((await call('chat-history','wrong_hr')).code,'TARGET_MISMATCH');assert.equal((await call('chat-history')).data.scrolled,true);assert.equal(await page.locator('textarea').inputValue(),'保留人工输入');assert.equal(await page.evaluate('(window.sends)'),0);
  await page.goto('https://www.zhipin.com/job_detail/known_job.html');await page.setContent('<div class="nav-figure"><span class="label-text">匿名</span></div><div class="job-banner" data-boss-id="known_hr"><button>立即沟通</button></div>');assert.equal((await call('chat-continue')).code,'ALREADY_CONTACTED');
  const continued=async()=>JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify({operation:'chat-continue',recruiterId:'known_hr',jobId:'known_job',content:'',intentId:'readonly',deadline:Date.now()+3000}))) as string);assert.equal((await continued()).code,'ALREADY_CONTACTED');await page.locator('button').evaluate(node=>{node.textContent='继续沟通';(window as any).opened=0;node.onclick=()=>{(window as any).opened++;};});assert.equal((await continued()).data.opened,true);assert.equal(await page.evaluate('(window.opened)'),1);
  await page.goto('https://www.zhipin.com/web/geek/jobs?query=iOS&city=101280600');await page.setContent('<div class="nav-figure"><span class="label-text">匿名</span></div><div class="pagination"><a class="next" href="https://www.zhipin.com/web/geek/jobs?query=iOS&city=101280600&page=2">下一页</a></div>');
  assert.equal((await call('search-next')).data.advanced,true);await page.waitForURL('**/web/geek/jobs?query=iOS&city=101280600&page=2');
  await page.setContent('<div class="nav-figure"><span class="label-text">匿名</span></div><div class="pagination"><a class="next" href="https://www.zhipin.com/web/geek/jobs?query=Java&city=101280600&page=3">下一页</a></div>');assert.equal((await call('search-next')).code,'ADAPTER_CHANGED');
 }finally{await browser.close();}
});
