import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {decodeBossDigits,normalizeJobText,normalizeCard,extractSearchDom,extractDetailDom} from '@jobpilot/boss-adapter';
import {Store} from '@jobpilot/store';
import {Application} from '../packages/worker/src/application.js';
import {demoJobs} from '../fixtures/boss/demo-jobs.js';
import {ruleFilter} from '@jobpilot/core';
import {MatchingPolicy} from '@jobpilot/contracts';

const encode=(text:string,base=0xe031)=>text.replace(/\d/g,n=>String.fromCharCode(base+Number(n)));
test('known BOSS digit alphabets decode correctly, salary is separate, and unknown glyphs never become guessed numbers',()=>{
  assert.equal(decodeBossDigits(encode('0123456789')),'0123456789');assert.equal(decodeBossDigits(encode('0123456789',0xe8f0)),'0123456789');
  const salary=encode('20-30K·14薪');assert.deepEqual(normalizeJobText('ios开发工程师'+salary,salary),{title:'ios开发工程师',salary:'20-30K·14薪'});
  assert.deepEqual(normalizeJobText('iOS 18 工程师（双休）','20-30K'),{title:'iOS 18 工程师（双休）',salary:'20-30K'});
  assert.equal(normalizeJobText('匿名实习工程师',encode('300元/天')).salary,'300元/天');
  assert.equal(normalizeJobText('匿名开发'+encode('20-30K'),'').title,'匿名开发');
  assert.deepEqual(normalizeJobText('匿名开发\ue100K','\ue100K'),{title:'匿名开发',salary:'薪资待核对'});assert.throws(()=>normalizeJobText('匿名\ue100开发','20-30K'),{code:'ADAPTER_CHANGED'});
  const job={...demoJobs()[0],salary:'薪资待核对'};assert(ruleFilter(job,MatchingPolicy.parse({minimumSalaryK:20})).some(r=>r.code==='SALARY_UNREADABLE'));
});
test('DOM title selection ignores nested salary and prefers the actual job-name over its parent container',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});try{
    const page=await browser.newPage(),salary=encode('20-30K·14薪');await page.setContent(`<div class="job-card-box"><a href="https://www.zhipin.com/job_detail/anonymous_font.html"><div class="job-title"><span class="job-name">iOS 开发工程师</span><span class="job-salary">${salary}</span></div></a><span class="company-name">匿名设备公司</span></div>`);
    const [raw]=await page.evaluate(extractSearchDom),job=normalizeCard(raw);assert.equal(raw.title,'iOS 开发工程师');assert.equal(job.title,'iOS 开发工程师');assert.equal(job.salary,'20-30K·14薪');
    await page.setContent(`<div class="job-banner"><div class="name"><h1>iOS 开发工程师<span class="salary">${salary}</span></h1></div></div><div class="job-sec-text">负责 iOS 客户端。</div>`);const detail=await page.evaluate(extractDetailDom);assert.equal(detail.title,'iOS 开发工程师');assert.equal(normalizeJobText(detail.title,detail.salary).salary,'20-30K·14薪');
  }finally{await browser.close();}
});
test('cached BOSS fields are repaired once on upgrade while facts and delivery evidence remain unchanged',async()=>{
  const dir=await mkdtemp('/tmp/jp-job-text-upgrade-'),store=new Store(dir),salary=encode('20-30K·14薪');const job={...demoJobs()[0],id:'boss:font_cached',platformJobId:'font_cached',source:'boss' as const,title:'iOS 开发工程师'+salary,salary};store.upsertJob(job);store.close();let app=new Application(dir);
  try{const corrected=app.store.getJob(job.id)!;assert.equal(corrected.title,'iOS 开发工程师');assert.equal(corrected.salary,'20-30K·14薪');assert.equal(corrected.jdText,job.jdText);assert.equal(corrected.snapshot,job.snapshot);assert.equal(app.sending.outbox().total,0);const once=JSON.stringify(corrected);await app.close();app=new Application(dir);assert.equal(JSON.stringify(app.store.getJob(job.id)),once);assert.equal(app.store.resume().facts.length,0);}finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
