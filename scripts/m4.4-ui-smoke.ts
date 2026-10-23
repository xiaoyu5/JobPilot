import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {Store} from '@jobpilot/store';
import {startWorker} from '../packages/worker/src/server.js';
import {callWorker} from '../packages/worker/src/client.js';
import {structuredResumeFixture} from '../tests/resume-fixtures.js';
import {demoJobs} from '../fixtures/boss/demo-jobs.js';

const dir=await mkdtemp('/tmp/jp-m44-ui-'),fixture=await structuredResumeFixture(dir),store=new Store(dir);
store.importFacts('previous.docx','old-ui',[{text:'旧版匿名客户端项目事实。',category:'project',source:{file:'previous.docx',kind:'docx',paragraph:1,quote:'旧版匿名客户端项目事实。'}}]);
store.addFact({expectedVersion:store.resume().version,text:'能够独立完成 App 开发并发布上线。',category:'experience'});
for(const fact of store.resume().facts)store.updateFact({id:fact.id,expectedVersion:fact.version,approved:true});store.freezeResume(store.resume().version);
const salary='20-30K·14薪'.replace(/\d/g,n=>String.fromCharCode(0xe031+Number(n))),job={...demoJobs()[0],id:'boss:font_ui',platformJobId:'font_ui',source:'boss' as const,title:'iOS 开发工程师'+salary,salary};store.upsertJob(job);store.close();
const worker=await startWorker(dir),browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeBinding('__jobpilotInvoke',async(_s,command:string,args:any)=>{if(command==='choose_resume')return fixture;if(command==='worker_request')return callWorker(dir,args.action,args.payload);throw new Error('unexpected native command');});
  await page.addInitScript('window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__jobpilotInvoke(command,args)};');
  await page.goto('http://127.0.0.1:1420/#/jobs');await page.getByText('● 本机已连接',{exact:true}).waitFor();await page.locator('.job-row').getByText('iOS 开发工程师',{exact:true}).waitFor();assert(!(await page.locator('.job-row').innerText()).match(/[\uE000-\uF8FF]/));await page.locator('.job-row').getByText('20-30K·14薪',{exact:true}).waitFor();
  await mkdir('.local/qa',{recursive:true});await page.screenshot({path:'.local/qa/m4.4-job-fields.png',fullPage:true});
  await page.getByRole('link',{name:'▧ 简历事实库',exact:true}).click();await page.getByRole('button',{name:'导入简历',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('heading',{name:'选择简历导入方式'}).waitFor();assert(await dialog.getByRole('button',{name:'导入为待审核事实'}).isDisabled());await dialog.getByLabel('简历导入方式',{exact:true}).selectOption('replace-imported');await dialog.getByText('归档旧简历 1 条，保留手动补充 1 条及旧快照；新版事实全部待审核。',{exact:true}).waitFor();await dialog.getByLabel('确认简历导入方式').check();await dialog.getByRole('button',{name:'导入为待审核事实'}).click();await dialog.waitFor({state:'hidden'});
  await page.getByText(/发现 1 条绝对化或数据边界/).waitFor();const result=(await callWorker(dir,'resume.list')).data as any;assert.equal(result.approvedCount,1);assert.equal(result.frozenVersion,null);assert(!result.facts.some((f:any)=>f.text==='旧版匿名客户端项目事实。'));assert(result.facts.some((f:any)=>f.text.startsWith('匿名地图项目：')&&!f.approved));
  await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:900,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await page.screenshot({path:'.local/qa/m4.4-facts-dark.png',fullPage:true});
  assert.deepEqual(errors,[]);assert.equal(((await callWorker(dir,'send.outbox')).data as any).total,0);console.log('PASS 0.4.4 UI: cache glyph repair, title/salary separation, explicit replacement dialog, private context-scoped facts, unchanged manual approval, new facts pending, dark/narrow layout; no sends.');
}finally{await browser.close();await worker.close();await rm(dir,{recursive:true,force:true});}
