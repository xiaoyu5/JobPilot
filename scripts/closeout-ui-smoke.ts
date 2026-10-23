import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright-core';
import {Store} from '@jobpilot/store';
import {prepare,withModel,goodResponse} from '../tests/m2-fixtures.js';
import {startWorker} from '../packages/worker/src/server.js';
import {callWorker} from '../packages/worker/src/client.js';
await withModel(body=>{const input=JSON.parse(body.messages[1].content);if(input.claims)return {supported:true,issues:[]};if(input.facts)return {claims:[{factId:input.facts[0].factId,text:'我在扫地机器人客户端项目中，曾负责地图协议解析与点云渲染相关工作，具备与岗位方向相关的实践经验。'}]};return goodResponse(body);},async config=>{
 const dir=await mkdtemp('/tmp/jp-closeout-ui-'),store=new Store(dir),base=prepare(store,config);store.updateConfig({bossReadOnlyConsent:true});store.close();const guiToken=randomBytes(32).toString('hex');
 const worker=await startWorker(dir,{guiToken,application:{workflowBrowser:{search:async(_profile,_signal,onJob)=>{onJob({...base,id:'boss:anonymous_workflow',platformJobId:'anonymous_workflow',source:'boss'});return 1;},readJob:async job=>job}}});assert((await callWorker(dir,'llm.env.save',config)).ok);
 const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeBinding('__jobpilotInvoke',async(_source,command,args)=>{assert.equal(command,'worker_request');return callWorker(dir,args.action,args.payload,190000,['workflow.schedule.save','chat.watch.set','queue.review'].includes(args.action)?guiToken:undefined);});await page.addInitScript('window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__jobpilotInvoke(command,args)};');
  await page.goto('http://127.0.0.1:1420/#/settings');await page.getByText('● 本机已连接',{exact:true}).waitFor();await page.getByRole('button',{name:'新增方案',exact:true}).click();await page.getByLabel('方案名称',{exact:true}).fill('匿名智能硬件');await page.getByLabel('最多结果页数',{exact:true}).fill('3');await page.getByRole('button',{name:'保存搜索方案',exact:true}).click();await page.getByText('搜索方案已保存。',{exact:true}).waitFor();assert.equal(((await callWorker(dir,'search.list')).data as any[]).length,2);
  await page.getByRole('link',{name:'◷ 执行记录',exact:true}).click();await page.getByRole('button',{name:'采集并匹配生成草稿',exact:true}).click();await page.getByRole('cell',{name:'BOSS · 连续任务',exact:true}).waitFor();await page.getByRole('cell',{name:'已完成',exact:true}).waitFor();assert.equal(((await callWorker(dir,'send.outbox')).data as any).total,0);
  await page.getByRole('button',{name:'保存并启用每日排程',exact:true}).click();await page.getByRole('button',{name:'关闭每日排程',exact:true}).waitFor();await page.getByRole('button',{name:'关闭每日排程',exact:true}).click();await page.getByRole('button',{name:'保存并启用每日排程',exact:true}).waitFor();
  await page.getByRole('link',{name:'▤ 岗位池',exact:true}).click();await page.locator('.job-row').first().click();await page.getByRole('button',{name:'生成自然文案（需审核）',exact:true}).click();await page.getByText('✓ 审计通过',{exact:true}).waitFor();await page.getByText('草稿中的事实引用',{exact:true}).click();await page.getByText(/此文案包含 AI 精炼表达/).waitFor();await page.getByText(/原事实：/).waitFor();
  await page.getByRole('link',{name:'☏ 会话助手',exact:true}).click();await page.getByRole('button',{name:'扫描联系人与新消息（只读）',exact:true}).waitFor();await page.getByRole('button',{name:'开启只读消息监测',exact:true}).click();await page.getByRole('button',{name:'停止消息监测',exact:true}).waitFor();await page.getByRole('button',{name:'急停 ⌘.',exact:true}).click();await page.getByRole('button',{name:'开启只读消息监测',exact:true}).waitFor();assert.equal(((await callWorker(dir,'chat.list')).data as any).autoEnabled,false);
  await page.getByRole('link',{name:'◷ 执行记录',exact:true}).click();await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:900,height:950});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));await mkdir('.local/qa',{recursive:true});await page.screenshot({path:'.local/qa/closeout-workflow-dark.png',fullPage:true});assert.deepEqual(errors,[]);console.log('PASS: profile CRUD, bounded pages, workflow preview, schedule enable/disable, natural rewrite provenance, explicit read-only monitoring and emergency stop; no real BOSS or messages.');
 }finally{await browser.close();await worker.close();await rm(dir,{recursive:true,force:true});}
});
