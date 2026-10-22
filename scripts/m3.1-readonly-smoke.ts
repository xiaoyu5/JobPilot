import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {callWorker} from '../packages/worker/src/client.js';
import {runtimePaths} from '../packages/worker/src/paths.js';
import {setTimeout as delay} from 'node:timers/promises';

// Real account verification is read-only: no model call, editor write or send authorization.
const root=runtimePaths().root,dir='.local/qa',file=`${dir}/m3.1-before.json`;
await mkdir(dir,{recursive:true});
const db=new DatabaseSync(`${root}/jobpilot.sqlite`,{readOnly:true});
const hash=(query:string)=>createHash('sha256').update(JSON.stringify(db.prepare(query).all())).digest('hex');
const count=(table:string)=>Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
const summary={schema:Number(db.prepare('PRAGMA user_version').get()!.user_version),jobs:hash('SELECT * FROM jobs ORDER BY id'),facts:hash('SELECT * FROM resume_facts ORDER BY id'),queue:hash('SELECT * FROM review_queue ORDER BY id'),jobCount:count('jobs'),factCount:count('resume_facts'),queueCount:count('review_queue')};
const item=db.prepare('SELECT id FROM review_queue ORDER BY created_at LIMIT 1').get();db.close();
if(process.argv.includes('--before')){
  assert.equal(summary.schema,3);await writeFile(file,JSON.stringify(summary,null,2),{mode:0o600});console.log('Saved v3 migration baseline: counts and hashes only.');
}else{
  assert(summary.schema>=4);
  const recheck=process.argv.includes('--recheck');
  if(!recheck){const before=JSON.parse(await readFile(file,'utf8'));for(const key of ['jobs','facts','queue','jobCount','factCount','queueCount'] as const)assert.equal(summary[key],before[key],`migration changed ${key}`);}
  else assert.equal(JSON.parse(await readFile(`${dir}/m3.1-migration.json`,'utf8')).migrationPreserved,true);
  assert.equal((await stat(`${root}/jobpilot.pre-m3.1.sqlite`)).mode&0o777,0o600);
  async function call(action:Parameters<typeof callWorker>[1],payload?:unknown){for(let attempt=0;;attempt++){try{return await callWorker(root,action,payload,45000);}catch(error){if(action!=='status'||attempt>=99)throw error;await delay(100);}}}
  const status=await call('status'),sending=await call('send.status'),chats=await call('chat.list'),outbox=await call('send.outbox'),chatOutbox=await call('chat.outbox');
  for(const result of [status,sending,chats,outbox,chatOutbox])assert(result.ok,result.error?.code??'WORKER_ERROR');
  assert.equal((status.data as any).llm.sessionReady,true);assert.equal((sending.data as any).policy.liveEnabled,false);assert.equal((sending.data as any).autoModeConsent,false);assert.equal((chats.data as any).autoEnabled,false);assert.equal((outbox.data as any).total,0);assert.equal((chatOutbox.data as any).items.length,0);
  const report:any={checkedAt:new Date().toISOString(),migrationPreserved:true,schema:summary.schema,jobs:summary.jobCount,facts:summary.factCount,queue:summary.queueCount,llmReady:true,liveEnabled:false,firstContactAuto:false,chatAuto:false,firstContactIntents:0,replyIntents:0};
  if(!recheck)await writeFile(`${dir}/m3.1-migration.json`,JSON.stringify(report,null,2),{mode:0o600});
  if(!process.argv.includes('--migration-only')){
    const login=await call('boss.login.open');report.login=login.ok?(login.data as any).state:login.error?.code;
    if(login.ok&&item){const result=await call('boss.communication.inspect',{id:item.id});const v=result.data as any;report.firstContact=result.ok?{entryKind:v.entryKind,identityBound:v.identityBound,recruiterKnown:!!v.recruiterId,composerReady:v.composerReady,alreadyContacted:v.alreadyContacted}:result.error?.code;const diagnostic=await call('boss.diagnostics');report.firstContactStructure=(diagnostic.data as any)?.structure;}
    const opened=await call('chat.open');report.chatOpened=opened.ok;
    if(opened.ok){const result=await call('chat.scan');const v=result.data as any;report.currentChat=result.ok?{imported:true,state:v.state}: {imported:false,code:result.error?.code};const diagnostic=await call('boss.diagnostics');report.chatStructure=(diagnostic.data as any)?.structure;}
    const after=await call('chat.outbox');assert.equal((after.data as any).items.length,0);
    await writeFile(`${dir}/m3.1-real-readonly.json`,JSON.stringify(report,null,2),{mode:0o600});
  }
  console.log(JSON.stringify(report,null,2));
}
