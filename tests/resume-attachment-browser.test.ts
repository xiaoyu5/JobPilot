import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const html=(mode='direct')=>`<meta charset="utf-8"><div class="nav-figure"><span class="label-text">匿名</span></div><section class="chat-conversation" data-boss-id="resume_hr"><span class="boss-name">匿名招聘人</span><div data-history-complete="true"></div><div class="message-item item-myself" data-mid="old_file"><div class="message-card-wrap"><span class="resume-name">anonymous.pdf</span></div><span class="message-status">送达</span></div><div class="message-item item-friend" data-mid="request_1"><div class="message-card-wrap"><h3 class="message-card-top-title">我想要一份您的附件简历，您是否同意</h3><button class="agree-btn">同意</button><button>拒绝</button></div></div><textarea>保留人工草稿</textarea></section><script>
window.agrees=0;window.attachments=0;window.textSends=0;
function delivered(){window.attachments++;const node=document.createElement('div');node.className='message-item item-myself';node.dataset.mid='new_file_'+window.attachments;node.innerHTML='<div class="message-card-wrap"><span class="resume-name">anonymous.pdf</span></div><span class="message-status">送达</span>';document.querySelector('.chat-conversation').append(node);}
document.querySelector('.agree-btn').onclick=()=>{window.agrees++;if('${mode}'==='direct')delivered();else{document.body.insertAdjacentHTML('beforeend','<div class="choose-resume-dialog"><div class="list-item"><span class="resume-name">anonymous.pdf</span></div>${mode==='ambiguous'?'<div class="list-item"><span class="resume-name">other.pdf</span></div>':''}<button class="btn-confirm">发送</button></div>');for(const item of document.querySelectorAll('.list-item'))item.onclick=()=>{item.classList.add('active');};document.querySelector('.btn-confirm').onclick=()=>{delivered();document.querySelector('.choose-resume-dialog').remove();};}};
</script>`;
test('manual resume card sends one attachment directly or through one selected version; existing files and text are never proof',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
  const source=await readFile('dist/worker/browser-actions.js','utf8');
  for(const mode of ['direct','dialog','ambiguous']){
   const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html(mode)}));await page.goto('https://www.zhipin.com/web/geek/chat');
   const call=async(operation:string,extra:object={})=>JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify({operation,purpose:'reply',jobId:'',recruiterId:'resume_hr',content:'',intentId:'attachment_intent',expectedInboundId:'request_1',deadline:Date.now()+3000,...extra}))) as string);
   assert.equal((await call('resume-prepare')).data.prepared,true);assert.equal(await page.evaluate('(window.agrees)'),0);assert.equal((await call('resume-verify')).data.state,'UNKNOWN');
   assert.equal((await call('resume-submit',{recruiterId:'wrong_hr'})).code,'TARGET_MISMATCH');assert.equal((await call('resume-submit',{deadline:Date.now()-1})).code,'ACTION_EXPIRED');
   assert.equal((await call('resume-submit')).data.submitted,true);assert.equal(await page.evaluate('(window.agrees)'),1);
   if(mode==='ambiguous'){assert.equal((await call('resume-dialog-send')).code,'RESUME_SELECTION_REQUIRED');assert.equal(await page.evaluate('(window.attachments)'),0);await page.close();continue;}
   if(mode==='dialog'){assert.equal((await call('resume-dialog-send')).data.done,false);assert.equal((await call('resume-dialog-send')).data.done,true);}
   assert.equal((await call('resume-verify')).data.state,'CONFIRMED');assert.equal(await page.evaluate('(window.attachments)'),1);assert.equal(await page.locator('textarea').inputValue(),'保留人工草稿');
   await call('resume-submit');await call('resume-dialog-send');assert.equal(await page.evaluate('(window.agrees)'),1);assert.equal(await page.evaluate('(window.attachments)'),1);
   await page.locator('[data-mid="new_file_1"] .message-status').evaluate(node=>node.textContent='发送中');assert.equal((await call('resume-verify')).data.state,'UNKNOWN');
   await page.close();
  }
 }finally{await browser.close();}
});
test('handled resume requests, new messages, refusals, incomplete histories and changed attachment selections cannot dispatch',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
  const source=await readFile('dist/worker/browser-actions.js','utf8');
  for(const scenario of ['handled','new','refused','history']){
   const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html()}));await page.goto('https://www.zhipin.com/web/geek/chat');
   await page.evaluate(scenario=>{if(scenario==='handled'){document.querySelector('.agree-btn')!.remove();document.querySelector('.message-card-top-title')!.textContent+='（已同意）';}if(scenario==='new'||scenario==='refused')document.querySelector('.chat-conversation')!.insertAdjacentHTML('beforeend','<div class="message-item item-friend" data-mid="new_inbound"><span class="text">'+(scenario==='refused'?'暂时不考虑，谢谢':'还有一个问题')+'</span></div>');if(scenario==='history')document.querySelector('[data-history-complete]')!.remove();},scenario);
   const result=JSON.parse(await page.evaluate(source.replace('__JOBPILOT_INPUT__',JSON.stringify({operation:'resume-submit',purpose:'reply',jobId:'',recruiterId:'resume_hr',content:'',intentId:'attachment_intent',expectedInboundId:'request_1',deadline:Date.now()+3000}))) as string);assert.equal(result.ok,false);assert.equal(await page.evaluate('(window.agrees)'),0);assert.equal(await page.evaluate('(window.attachments)'),0);await page.close();
  }
 }finally{await browser.close();}
});
