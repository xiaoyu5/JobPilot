import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {Store} from '@jobpilot/store';
import {startWorker} from '../packages/worker/src/server.js';
import {callWorker} from '../packages/worker/src/client.js';
import {withModel,goodResponse,prepare,mapFact} from '../tests/m2-fixtures.js';

await withModel(goodResponse,async config=>{
  const dir=await mkdtemp('/tmp/jp-m2-ui-'),store=new Store(dir);const job=prepare(store,config);store.close();
  const worker=await startWorker(dir);await callWorker(dir,'llm.env.save',config);const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
  try{
    const errors:string[]=[];const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
    await page.exposeBinding('__jobpilotInvoke',async(_s,command:string,args:any)=>{
      if(command==='worker_request')return callWorker(dir,args.action,args.payload);
      if(command==='llm_key_status')return true;throw new Error('unexpected native bridge');
    });
    await page.addInitScript('window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__jobpilotInvoke(command,args)};');
    await page.goto('http://127.0.0.1:1420/#/jobs');await page.getByText('● 本机已连接',{exact:true}).waitFor();
    await page.locator('.job-row').first().click();await page.getByRole('button',{name:'匹配这个岗位',exact:true}).click();
    await page.locator('.evidence-quote mark').getByText(mapFact,{exact:true}).waitFor();
    await page.getByRole('button',{name:'生成中文草稿',exact:true}).click();await page.getByText('✓ 审计通过',{exact:true}).waitFor();
    await page.getByRole('button',{name:'加入审核队列',exact:true}).click();
    await page.getByRole('link',{name:'☷ 审核队列',exact:true}).click();await page.getByRole('button',{name:'标记已审核',exact:true}).waitFor();
    await page.getByRole('button',{name:'标记已审核',exact:true}).click();await page.getByText('本地已审核',{exact:true}).waitFor();
    const textarea=page.getByRole('textbox',{name:'招呼语草稿'}),original=await textarea.inputValue();
    await textarea.fill(original+'我独立实现了 P2P 内核。');assert(await page.getByRole('button',{name:'标记已审核',exact:true}).isDisabled());
    await page.getByRole('button',{name:'保存并重新审计',exact:true}).click();await page.getByText('草稿被阻断',{exact:true}).waitFor();
    await textarea.fill(original);await page.getByRole('button',{name:'保存并重新审计',exact:true}).click();await page.getByText('待你审核',{exact:true}).waitFor();
    await mkdir('.local/qa',{recursive:true});await page.screenshot({path:'.local/qa/m2-queue.png',fullPage:true});
    await page.getByRole('link',{name:'◫ 总览',exact:true}).click();await page.getByLabel('Dry Run 来源').selectOption('demo');
    await page.getByRole('button',{name:'开始 Dry Run（最多 20 条）',exact:true}).click();
    await page.getByRole('button',{name:'查看记录',exact:true}).first().click();await page.getByText('DRY_RUN_COMPLETED',{exact:true}).waitFor({timeout:15000});
    await page.screenshot({path:'.local/qa/m2-dry-run.png',fullPage:true});
    await page.getByRole('link',{name:'⚙ 设置',exact:true}).click();await page.getByLabel('排除公司关键词',{exact:true}).fill('甲，乙');
    await page.getByRole('button',{name:'保存匹配规则',exact:true}).click();await page.getByText('规则已保存，旧结果已失效。',{exact:true}).waitFor();
    await page.getByRole('link',{name:'☷ 审核队列',exact:true}).click();await page.getByText('版本已失效',{exact:true}).first().waitFor();
    await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:'.local/qa/m2-queue-dark.png',fullPage:true});
    await page.setViewportSize({width:900,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.getByRole('link',{name:'▧ 简历事实库',exact:true}).click();
    await page.locator('summary').filter({hasText:'补充一条真实事实'}).click();
    await page.getByLabel('补充事实内容',{exact:true}).fill('能够独立完成匿名App开发并发布上线。');
    await page.getByLabel('补充事实类别',{exact:true}).selectOption('experience');
    await page.getByRole('button',{name:'添加待审核事实',exact:true}).click();
    await page.getByText('已补充待审核事实，请核对后确认并重新冻结。',{exact:true}).waitFor();
    const facts=(await callWorker(dir,'resume.list')).data as any,added=facts.facts.find((f:any)=>f.text==='能够独立完成匿名App开发并发布上线。');
    assert(added);assert.equal(added.approved,false);assert.equal(added.source.kind,'text');assert.equal(facts.frozenVersion,null);
    await page.screenshot({path:'.local/qa/m4.2-manual-fact-dark.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    assert.deepEqual(errors,[]);assert.equal((await callWorker(dir,'status')).data && (await callWorker(dir,'status')).ok,true);
    console.log('PASS M2 UI: actual Worker/model fixture, matching evidence, audited draft, local review, edited-claim block, Dry Run timeline, policy invalidation, dark/narrow layouts; no page errors.');
  }finally{await browser.close();await worker.close();await rm(dir,{recursive:true,force:true});}
});
