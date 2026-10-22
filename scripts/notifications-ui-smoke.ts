import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Store} from '@jobpilot/store';
import {startWorker} from '../packages/worker/src/server.js';
import {callWorker} from '../packages/worker/src/client.js';
import {withModel,goodResponse} from '../tests/m2-fixtures.js';
import {seedSendQueue} from '../tests/m3-fixtures.js';

await withModel(goodResponse,async config=>{
  const dir=await mkdtemp('/tmp/jp-notifications-ui-'),store=new Store(dir),[item]=await seedSendQueue(store,config,1);
  store.db.prepare("UPDATE review_queue SET state='PENDING' WHERE id=?").run(item.queueId);store.close();
  const guiToken=randomBytes(32).toString('hex');let now=Date.now(),calls=0,fail=false;
  const bodies:string[]=[];
  const worker=await startWorker(dir,{guiToken,application:{clock:()=>now,notifications:{intervalMs:600000,fetch:async(_url,options)=>{calls++;bodies.push(String(options?.body));return new Response(JSON.stringify(fail?{errcode:93000,errmsg:'anonymous error'}:{errcode:0}));}}}});
  const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
  try{
    assert((await callWorker(dir,'llm.env.save',config)).ok);
    const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.exposeBinding('__jobpilotInvoke',async(_s,command:string,args:any)=>{assert.equal(command,'worker_request');return callWorker(dir,args.action,args.payload,190000,['notifications.save','notifications.test','notifications.check'].includes(args.action)?guiToken:undefined);});
    await page.addInitScript('window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__jobpilotInvoke(command,args)};');
    await page.goto('http://127.0.0.1:1420/#/settings');const panel=page.locator('.notification-settings');await panel.getByRole('heading',{name:'企业微信通知',exact:true}).waitFor();
    assert.equal(await panel.getByLabel('启用企业微信通知',{exact:true}).isChecked(),false);assert(await panel.getByRole('button',{name:'发送测试通知',exact:true}).isDisabled());
    const key=panel.getByLabel('企业微信 Webhook',{exact:true});assert.equal(await key.getAttribute('type'),'password');
    await key.fill('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=ui-anonymous-key');await panel.getByRole('button',{name:'保存通知配置',exact:true}).click();await panel.getByText('通知配置已保存。开启后会检查现有待办。',{exact:true}).waitFor();assert.equal(await key.inputValue(),'');assert.equal(calls,0);
    await panel.getByRole('button',{name:'发送测试通知',exact:true}).click();await panel.getByText('企业微信已接收测试通知，请在手机确认。',{exact:true}).waitFor();assert.equal(calls,1);assert(bodies[0].includes('测试通知'));
    await panel.getByLabel('启用企业微信通知',{exact:true}).check();await panel.getByRole('button',{name:'保存通知配置',exact:true}).click();await panel.getByText('通知配置已保存。开启后会检查现有待办。',{exact:true}).waitFor();
    now+=61000;fail=true;await panel.getByRole('button',{name:'检查待办并通知',exact:true}).click();await panel.getByText(/错误码 93000/).waitFor();assert.equal(calls,2);
    now+=61000;fail=false;await panel.getByRole('button',{name:'检查待办并通知',exact:true}).click();await panel.getByText('已检查待办；相同内容不重复通知，通知间隔至少一分钟。',{exact:true}).waitFor();assert.equal(calls,3);assert(bodies[2].includes('首联草稿待审核：1'));assert(!bodies[2].includes(item.draft.content));
    now+=61000;await panel.getByRole('button',{name:'检查待办并通知',exact:true}).click();await panel.getByText('已检查待办；相同内容不重复通知，通知间隔至少一分钟。',{exact:true}).waitFor();assert.equal(calls,3);
    await page.reload();await panel.getByLabel('启用企业微信通知',{exact:true}).waitFor();assert(await panel.getByLabel('启用企业微信通知',{exact:true}).isChecked());assert.equal(await key.inputValue(),'');assert(!(await panel.innerText()).includes('ui-anonymous-key'));
    await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:900,height:900});await panel.scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await mkdir('.local/qa',{recursive:true});await panel.screenshot({path:'.local/qa/m4.3-notifications-dark.png'});
    const send=(await callWorker(dir,'send.status')).data as any;assert.equal(send.policy.liveEnabled,false);assert.equal(send.autoModeConsent,false);assert.equal((await callWorker(dir,'send.outbox')).data&&((await callWorker(dir,'send.outbox')).data as any).total,0);assert.deepEqual(errors,[]);
    console.log('PASS notification UI: disabled default, private env save and masked key, fixed test, pending-review digest, API error and manual recovery, reload persistence, duplicate suppression, dark/narrow layout; all pushes mocked, no BOSS sends.');
  }finally{await browser.close();await worker.close();await rm(dir,{recursive:true,force:true});}
});
