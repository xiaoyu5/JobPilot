import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,copyFile,stat} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {chromium} from 'playwright-core';
import {Store} from '@jobpilot/store';
import {startWorker} from '../packages/worker/src/server.js';
import {callWorker} from '../packages/worker/src/client.js';
import {withModel,goodResponse} from '../tests/m2-fixtures.js';
import {seedSendQueue} from '../tests/m3-fixtures.js';
await withModel(goodResponse,async config=>{
  assert(config.apiKey);
  const dir=await mkdtemp('/tmp/jp-m4-ui-'),outside=await mkdtemp('/tmp/jp-m4-ui-export-'),store=new Store(dir);const [first]=await seedSendQueue(store,config);const run=store.createRun('boss'),receipt=randomUUID();
  store.db.prepare("INSERT INTO send_outbox(id,job_id,recruiter_id,idem_key,draft_id,state,run_id,created_at,message_units,confirmed_units,phase,default_phase) VALUES(?,?,?,?,?,'SENT_CONFIRMED',?,?,2,2,'CONFIRMED','CONFIRMED')").run(receipt,first.job.id,first.job.recruiterId,receipt,first.draft.id,run.id,new Date().toISOString());store.finishRun(run.id,'COMPLETED');store.close();
  const guiToken=randomBytes(32).toString('hex');let worker=await startWorker(dir,{guiToken}),backup='',diagnostic='',restarts=0;const browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.exposeBinding('__jobpilotInvoke',async(_source,command:string,args:any)=>{
      if(command==='choose_backup')return backup;
      if(command==='reveal_artifact')return;
      if(command==='save_artifact'){const destination=`${outside}/saved-${randomUUID()}`;await copyFile(args.path,destination);return destination;}
      if(command==='restart_after_data'){await worker.close();worker=await startWorker(dir,{guiToken});restarts++;return;}
      assert.equal(command,'worker_request');const protectedAction=args.action.startsWith('data.')&&args.action!=='data.status'||['outcomes.update','diagnostics.export'].includes(args.action);const result=await callWorker(dir,args.action,args.payload,30000,protectedAction?guiToken:undefined);
      if(result.ok&&args.action==='data.backup')backup=(result.data as any).path;if(result.ok&&args.action==='diagnostics.export')diagnostic=(result.data as any).path;return result;
    });
    await page.addInitScript('window.__TAURI_INTERNALS__={invoke:(command,args)=>window.__jobpilotInvoke(command,args)};');
    await page.goto('http://127.0.0.1:1420/#/review');await page.getByText('● 本机已连接',{exact:true}).waitFor();await page.getByText('JobPilot 已确认 2 条首联消息',{exact:true}).waitFor();
    const card=page.locator('.outcome-card').filter({hasText:'匿名待发岗位 1'});await card.getByLabel('已邀面 匿名待发岗位 1',{exact:true}).check();assert(await card.getByLabel('已回复 匿名待发岗位 1',{exact:true}).isChecked());await card.getByLabel('复盘备注 匿名待发岗位 1',{exact:true}).fill('匿名邀面记录');await card.getByRole('button',{name:'保存结果标记',exact:true}).click();await page.getByText('100.0%',{exact:true}).first().waitFor();
    assert.equal(((await callWorker(dir,'stats.get')).data as any).confirmedContacts,1);assert.equal(((await callWorker(dir,'stats.get')).data as any).interviews,1);
    const other=page.locator('.outcome-card').filter({hasText:'匿名待发岗位 2'});await other.getByLabel('已拒绝 匿名待发岗位 2',{exact:true}).check();await other.getByRole('button',{name:'保存结果标记',exact:true}).click();await page.getByText(/另有 1 个手动标记的历史沟通/).waitFor();assert.equal(((await callWorker(dir,'stats.get')).data as any).replyRate,1);
    await mkdir('.local/qa',{recursive:true});await page.screenshot({path:'.local/qa/m4-review-light.png',fullPage:true});
    await page.getByRole('link',{name:'▣ 数据与诊断',exact:true}).click();await page.getByRole('button',{name:'创建私密备份',exact:true}).click();await page.getByRole('heading',{name:/文件已生成/}).waitFor();assert(backup);await page.getByRole('button',{name:'另存到…',exact:true}).click();await page.getByText(/已另存：/).waitFor();
    await page.getByRole('button',{name:'选择备份恢复…',exact:true}).click();const restore=page.getByRole('dialog');await restore.getByRole('heading',{name:'确认恢复备份',exact:true}).waitFor();assert(await restore.getByRole('button',{name:'确认恢复并重启',exact:true}).isDisabled());await restore.getByLabel('确认替换本机数据').check();await restore.getByRole('button',{name:'确认恢复并重启',exact:true}).click();await restore.waitFor({state:'hidden'});for(let n=0;n<100&&restarts<1;n++)await page.waitForTimeout(100);assert.equal(restarts,1);assert.equal(((await callWorker(dir,'config.get')).data as any).bossReadOnlyConsent,false);assert.equal(((await callWorker(dir,'send.status')).data as any).policy.liveEnabled,false);
    await page.getByRole('button',{name:'导出脱敏诊断',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.artifact-panel .file-path')?.textContent?.includes('/exports/diagnostics-'));assert(diagnostic);const contents=await readFile(diagnostic,'utf8');assert(!contents.includes(config.apiKey));assert(!contents.includes('匿名邀面记录'));assert(!contents.includes('Welgoo'));assert.equal((await stat(diagnostic)).mode&0o777,0o600);
    await page.getByLabel('清理来源').selectOption('demo');await page.getByLabel('清理截止日期').fill('2099-01-01');await page.getByRole('button',{name:'预览清理范围',exact:true}).click();await page.getByText(/符合范围且无保护记录的岗位/).waitFor();assert(await page.getByRole('button',{name:'清理 1 个岗位',exact:true}).isDisabled());await page.getByLabel('确认清理岗位').check();await page.getByRole('button',{name:'清理 1 个岗位',exact:true}).click();for(let n=0;n<50;n++){if(((await callWorker(dir,'jobs.list',{source:'demo'})).data as any).total===0)break;await page.waitForTimeout(100);}assert.equal(((await callWorker(dir,'jobs.list',{source:'boss'})).data as any).total,2);assert.equal(((await callWorker(dir,'resume.list')).data as any).approvedCount,2);
    await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:900,height:900});await page.screenshot({path:'.local/qa/m4-data-dark.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.getByRole('button',{name:'清除本机数据…',exact:true}).click();const reset=page.getByRole('dialog');assert(await reset.getByRole('button',{name:'确认清除并重启',exact:true}).isDisabled());await reset.getByLabel('清除数据确认文字').fill('清除 JobPilot 本机数据');await reset.getByRole('button',{name:'确认清除并重启',exact:true}).click();await reset.waitFor({state:'hidden'});for(let n=0;n<100&&restarts<2;n++)await page.waitForTimeout(100);assert.equal(restarts,2);assert.equal(((await callWorker(dir,'jobs.list')).data as any).total,0);assert.equal(((await callWorker(dir,'resume.list')).data as any).facts.length,0);assert.equal(((await callWorker(dir,'send.outbox')).data as any).total,0);assert.deepEqual(errors,[]);
    console.log('PASS: M4 outcome cohorts, manual feedback, external-contact separation, private backup/save, restore+restart with grants disabled, diagnostic privacy, exact cleanup scope and typed full reset. All data and native dialogs are isolated fixtures; no real BOSS access or sending.');
  }finally{await browser.close();await worker.close();await rm(dir,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
