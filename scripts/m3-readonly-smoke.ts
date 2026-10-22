import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {callWorker} from '../packages/worker/src/client.js';
import {runtimePaths} from '../packages/worker/src/paths.js';
import {setTimeout as delay} from 'node:timers/promises';
import type {WorkerStatus,ResumeState,SendingStatus,CommunicationInspection} from '@jobpilot/contracts';

// Real account access stays read-only. Never changes policy, confirms a draft, or invokes a send.
const dir=runtimePaths().root;
const db=new DatabaseSync(`${dir}/jobpilot.sqlite`,{readOnly:true});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summary={schema:(db.prepare('PRAGMA user_version').get() as any).user_version,jobs:hash(db.prepare('SELECT * FROM jobs ORDER BY id').all()),facts:hash(db.prepare('SELECT * FROM resume_facts ORDER BY id').all()),queue:hash(db.prepare('SELECT * FROM review_queue ORDER BY id').all()),jobCount:(db.prepare('SELECT count(*) n FROM jobs').get() as any).n,factCount:(db.prepare('SELECT count(*) n FROM resume_facts WHERE deleted=0').get() as any).n,queueCount:(db.prepare('SELECT count(*) n FROM review_queue').get() as any).n};db.close();
await mkdir('.local/qa',{recursive:true});
if(process.argv.includes('--before')){
  await writeFile('.local/qa/m3-before.json',JSON.stringify(summary,null,2),{mode:0o600});console.log('Saved migration baseline: hashes and counts only.');
}else{
  const recheck=process.argv.includes('--recheck');assert(summary.schema>=4);
  if(recheck){const previous=JSON.parse(await readFile('.local/qa/m3-real-readonly.json','utf8'));assert.equal(previous.migrationPreserved,true,'initial migration audit must pass before a live recheck');}
  else {const before=JSON.parse(await readFile('.local/qa/m3-before.json','utf8'));for(const field of ['jobs','facts','queue','jobCount','factCount','queueCount'] as const)assert.equal(summary[field],before[field],`migration changed ${field}`);}
  assert.equal((await stat(`${dir}/jobpilot.pre-m3.sqlite`)).mode&0o777,0o600);
  async function call<T>(action:Parameters<typeof callWorker>[1],payload?:unknown):Promise<T>{let result;for(let attempt=0;;attempt++){try{result=await callWorker(dir,action,payload,30000);break;}catch(error){if(action!=='status'||attempt>=99)throw error;await delay(100);}}assert(result.ok,result.error?.code??'WORKER_ERROR');return result.data as T;}
  const status=await call<WorkerStatus>('status'),sending=await call<SendingStatus>('send.status'),resume=await call<ResumeState>('resume.list');
  assert.equal(status.milestone,'M4');assert.equal(status.llm.sessionReady,true);assert.equal(sending.autoModeConsent,false);assert.equal(sending.policy.liveEnabled,false);assert.equal((await call<{total:number}>('send.outbox')).total,0);
  const opened=await callWorker(dir,'boss.login.open',undefined,30000);
  const login=opened.ok?opened.data as {state:string}:{state:opened.error?.code??'UNKNOWN'};
  const queue=await call<{items:{id:string}[]}>('queue.list');
  let inspection:unknown=null;
  if(queue.items.length&&login.state==='LOGGED_IN'){
    const info=await call<CommunicationInspection>('boss.communication.inspect',{id:queue.items[0].id});
    inspection={entryKind:info.entryKind,identityBound:info.identityBound,recruiterKnown:!!info.recruiterId,composerReady:info.composerReady,canOpenPreview:info.canOpenPreview,alreadyContacted:info.alreadyContacted,message:info.message};
  }
  const report={checkedAt:new Date().toISOString(),migrationPreserved:true,migrationRechecked:!recheck,schema:summary.schema,jobs:summary.jobCount,facts:summary.factCount,queue:summary.queueCount,resumeVersion:resume.version,frozenVersion:resume.frozenVersion,llmReady:status.llm.sessionReady,auto:false,liveEnabled:false,outbox:0,login:login.state,inspection};
  await writeFile('.local/qa/m3-real-readonly.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2));
}
