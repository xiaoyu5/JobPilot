import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { startWorker } from '../packages/worker/src/server.js';
import { callWorker } from '../packages/worker/src/client.js';
import { docxFixture } from '../tests/fixtures.js';

const directory=await mkdtemp('/tmp/jp-ui-');const worker=await startWorker(directory);
const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
try{
  const fixture=await docxFixture(directory),errors:string[]=[];let hasKey=false;
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));
  await page.exposeBinding('__jobpilotInvoke',async(_source,command:string,args:any)=>{
    if(command==='worker_request')return callWorker(directory,args.action,args.payload);
    if(command==='choose_resume')return fixture;
    if(command==='llm_key_status')return hasKey;
    if(command==='save_llm'){hasKey=!args.clearKey&&Boolean(args.apiKey);return callWorker(directory,'config.update',{llm:args.configuration});}
    throw new Error('Unexpected test command');
  });
  await page.addInitScript('window.__TAURI_INTERNALS__ = { invoke: function(command, args) { return window.__jobpilotInvoke(command, args); } };');
  await page.goto('http://127.0.0.1:1420/#/dashboard');await page.getByText('● 本机已连接',{exact:true}).waitFor({timeout:10000}).catch(async error=>{console.error('UI errors:',errors);console.error((await page.locator('body').innerText()).slice(0,2000));throw error;});
  await page.getByRole('link',{name:'▧ 简历事实库'}).click();await page.getByRole('button',{name:'导入简历',exact:true}).click();
  await page.locator('.fact-card').first().waitFor();assert.equal(await page.locator('.fact-card.approved').count(),0);
  await page.locator('.fact-card').first().getByRole('button',{name:'确认事实',exact:true}).click();await page.locator('.fact-card.approved').waitFor();
  await page.getByRole('button',{name:'冻结已确认事实',exact:true}).click();await page.getByText(/已冻结 v/).waitFor();
  await mkdir('.local/qa',{recursive:true});await page.screenshot({path:'.local/qa/m1-resume.png',fullPage:true});
  await page.getByRole('link',{name:'⚙ 设置'}).click();
  await page.getByLabel('Base URL',{exact:true}).fill('http://localhost:1/v1');await page.getByLabel('模型名称',{exact:true}).fill('anonymous-fixture');
  await page.getByLabel('API Key',{exact:true}).fill('ui-fixture-never-persist');await page.getByRole('button',{name:'保存模型配置',exact:true}).click();
  await page.getByText('模型配置已保存到 .env 文件。',{exact:true}).waitFor();
  await page.getByLabel('方案名称',{exact:true}).fill('UI 匿名方案');await page.getByLabel('采集上限',{exact:true}).fill('7');await page.getByRole('button',{name:'保存搜索方案',exact:true}).click();
  await page.getByText('搜索方案已保存。',{exact:true}).waitFor();
  await page.getByRole('link',{name:'◫ 总览'}).click();await page.getByRole('button',{name:'载入匿名演示',exact:true}).click();
  await page.locator('.job-row').first().waitFor();assert.equal(await page.locator('.job-row').count(),20);
  await page.locator('.job-row').first().click();await page.locator('.detail-panel').waitFor();await page.screenshot({path:'.local/qa/m1-jobs.png',fullPage:true});
  await page.getByRole('link',{name:'◷ 执行记录'}).click();await page.getByRole('button',{name:'查看记录',exact:true}).first().click();await page.getByText('RUN_COMPLETED',{exact:true}).waitFor();
  await page.screenshot({path:'.local/qa/m1-runs.png',fullPage:true});
  await page.getByRole('link',{name:'◫ 总览'}).click();await page.getByRole('heading',{name:'让下一次机会，有据可循。',exact:true}).waitFor();await page.screenshot({path:'.local/qa/m1-dashboard.png',fullPage:true});
  await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:'.local/qa/m1-dashboard-dark.png',fullPage:true});
  await page.setViewportSize({width:900,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'minimum window should not overflow');
  assert.deepEqual(errors,[]);
  assert.equal((await readFile(`${directory}/jobpilot.sqlite`)).includes('ui-fixture-never-persist'),false);
  console.log('PASS: five-page UI uses real Worker IPC, imports/reviews/freezes facts, saves configuration, renders 20 jobs and event timeline; no page errors or narrow-window overflow. Only the native file picker is mocked; model settings use the actual private .env file.');
}finally{await browser.close();await worker.close();await rm(directory,{recursive:true,force:true});}
