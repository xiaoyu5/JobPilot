import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Store} from '@jobpilot/store';
import type {SendTransport} from '../packages/core/src/sending.js';
import {startWorker} from '../packages/worker/src/server.js';
import {callWorker} from '../packages/worker/src/client.js';
import {withModel,goodResponse} from '../tests/m2-fixtures.js';
import {seedSendQueue} from '../tests/m3-fixtures.js';
await withModel(goodResponse,async config=>{
 const dir=await mkdtemp('/tmp/jp-followup-ui-'),store=new Store(dir);await seedSendQueue(store,config,1);store.close();
 let defaults=0,submitted=0,proof=false,now=Date.parse('2026-10-23T10:00:00Z');const guiToken=randomBytes(32).toString('hex');
 const transport:SendTransport={inspectCommunication:async job=>({job,inspection:{jobId:job.id,recruiterId:job.recruiterId,identityBound:true,composerReady:false,canOpenPreview:false,alreadyContacted:false,entryKind:'instant-send',message:'anonymous modal',url:job.url,adapterVersion:'fixture'}}),startContact:async()=>{defaults++;},verifyContact:async()=>proof?{state:'CONFIRMED',messageId:'visible-receipt:anonymous_default',message:'receipt'}:{state:'UNKNOWN',message:'unknown modal'},prepareGreeting:async()=>{},submitGreeting:async()=>{submitted++;},verifyGreeting:async()=>({state:'CONFIRMED',messageId:'visible-receipt:anonymous_ai',message:'receipt'})};
 const worker=await startWorker(dir,{guiToken,application:{transport,health:async()=>true,clock:()=>now}}),browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
 try{
  assert((await callWorker(dir,'llm.env.save',config)).ok);const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeBinding('__jobpilotInvoke',async(_s,command:string,args:any)=>{assert.equal(command,'worker_request');return callWorker(dir,args.action,args.payload,190000,['send.policy.save','send.commit','send.followup.commit'].includes(args.action)?guiToken:undefined);});await page.addInitScript('window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__jobpilotInvoke(command,args)};');
  await page.goto('http://127.0.0.1:1420/#/settings');await page.getByText('● 本机已连接',{exact:true}).waitFor();await page.getByLabel('允许真实发送',{exact:true}).check();await page.getByLabel('发送时区',{exact:true}).fill('UTC');await page.getByLabel('允许开始时间').fill('00:00');await page.getByLabel('允许结束时间').fill('23:59');await page.getByLabel('确认发送限制').check();await page.getByRole('button',{name:'保存发送规则',exact:true}).click();
  await page.getByRole('link',{name:'☷ 审核队列',exact:true}).click();await page.locator('.queue-card').getByRole('button',{name:'发送前检查（1）',exact:true}).click();let dialog=page.getByRole('dialog');await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'确认发送 2 条',exact:true}).click();await page.getByText('待人工核验',{exact:true}).waitFor();assert.equal(defaults,1);assert.equal(submitted,0);
  proof=true;now+=20000;await page.getByRole('button',{name:'检查仅续发 AI 文案',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByText(/默认招呼已有页面回执/).waitFor();assert(await dialog.getByRole('button',{name:'确认发送 1 条',exact:true}).isDisabled());assert.equal(submitted,0);
  const record=((await callWorker(dir,'send.outbox')).data as any).items[0];const readonlyPlan=await callWorker(dir,'send.followup.prepare',{id:record.id});assert.equal((await callWorker(dir,'send.followup.commit',{planId:(readonlyPlan.data as any).id,confirmed:true})).error?.code,'GUI_AUTH_REQUIRED');
  await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:900,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await mkdir('.local/qa',{recursive:true});await page.screenshot({path:'.local/qa/m4.4-followup-confirm.png',fullPage:true});
  await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'确认发送 1 条',exact:true}).click();await page.getByText('页面已确认',{exact:true}).waitFor();const outbox=(await callWorker(dir,'send.outbox')).data as any;assert.equal(outbox.total,1);assert.equal(outbox.items[0].id,record.id);assert.equal(outbox.items[0].confirmedUnits,2);assert.equal(defaults,1);assert.equal(submitted,1);assert.equal((await callWorker(dir,'send.status')).data&&(await callWorker(dir,'send.status')).ok,true);assert.deepEqual(errors,[]);
  console.log('PASS follow-up UI: default-only uncertainty, read-only receipt check, native-only separate one-AI confirmation, original locked content/intent/quota, one default and one AI, dark/narrow dialog. Anonymous fixtures only.');
 }finally{await browser.close();await worker.close();await rm(dir,{recursive:true,force:true});}
});
