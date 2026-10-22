import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {callWorker} from '../packages/worker/src/client.js';
import {runtimePaths} from '../packages/worker/src/paths.js';
const run=promisify(execFile),root=runtimePaths().root,app=resolve(process.env.JOBPILOT_APP_PATH??`${homedir()}/Applications/JobPilot.app`);
const startedAt=new Date().toISOString(),checks=[],once=process.argv.includes('--once');
async function call(action:Parameters<typeof callWorker>[1]){const r=await callWorker(root,action,undefined,30000);assert(r.ok,r.error?.code??'WORKER_ERROR');return r.data as any;}
async function ready(){for(let i=0;i<150;i++){try{return await call('status');}catch{await delay(100);}}throw new Error('Normal Launch Services startup did not establish a Worker');}
for(let pass=0;pass<(once?1:2);pass++){
  // Real normal startup: no ApplePersistenceIgnoreState or other diagnostic launch flags.
  await run('/usr/bin/open',['-n','-a',app,'--stderr',`${root}/desktop-stderr.log`,'--stdout',`${root}/desktop-stdout.log`]);
  const status=await ready(),sending=await call('send.status'),chats=await call('chat.list');
  assert.equal(status.llm.sessionReady,true);assert.equal(status.llm.envPath,`${root}/.env`);assert.equal(sending.policy.liveEnabled,false);assert.equal(sending.autoModeConsent,false);assert.equal(chats.autoEnabled,false);assert.equal((await call('send.outbox')).total,0);assert.equal((await call('chat.outbox')).items.length,0);
  const login=await call('boss.login.open');
  checks.push({normalStartup:true,workerPid:status.pid,llmReady:true,configurationLocation:'Application Support',live:false,firstContactAuto:false,chatAuto:false,firstContactIntents:0,replyIntents:0,login:login.state});
  if(pass===0&&!once){
    const parent=Number((await run('/bin/ps',['-p',String(status.pid),'-o','ppid='])).stdout.trim());
    assert.equal((await run('/bin/ps',['-p',String(parent),'-o','command='])).stdout.trim(),`${app}/Contents/MacOS/jobpilot`);
    process.kill(parent,'SIGTERM');
    let offline=false;for(let i=0;i<100;i++){try{await callWorker(root,'status',undefined,200);}catch{offline=true;break;}await delay(100);}assert(offline);await delay(500);
  }
}
if(!once)assert.notEqual(checks[0].workerPid,checks[1].workerPid);
const report={startedAt,checkedAt:new Date().toISOString(),application:app,checks};await writeFile(`.local/qa/${once?'m3.1-final-startup':'m3.1-normal-startup'}.json`,JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
