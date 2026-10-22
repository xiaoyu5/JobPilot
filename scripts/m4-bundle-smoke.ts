import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,realpath,rm,writeFile,stat,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {Store} from '@jobpilot/store';
import {DataService} from '../packages/worker/src/data.js';
import {saveEnvironment} from '../packages/worker/src/environment.js';
import {callWorker} from '../packages/worker/src/client.js';
import {prepare} from '../tests/m2-fixtures.js';
import type {WorkerStatus,Request} from '@jobpilot/contracts';
const {productName,version}=JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json','utf8'));
const app=await realpath(process.argv[2]??`apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/${productName}.app`),dir=await mkdtemp('/tmp/jp-m4-bundle-');
const config={baseUrl:'http://127.0.0.1:1/v1',model:'anonymous-offline-fixture',apiKey:'anonymous-private-key',timeoutMs:1000,allowLan:false};
let desktop:ChildProcess|undefined,clients:Client[]=[];const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function call<T=any>(action:Request['action'],payload?:unknown):Promise<T>{const value=await callWorker(dir,action,payload,10000);assert(value.ok,value.error?.code??'WORKER_ERROR');return value.data as T;}
const start=async()=>{desktop=spawn(`${app}/Contents/MacOS/jobpilot`,['-ApplePersistenceIgnoreState','YES'],{env:{...process.env,PATH:'/usr/bin:/bin',JOBPILOT_DATA_DIR:dir,NODE_OPTIONS:'',NODE_PATH:''},stdio:'ignore'});for(let i=0;i<150;i++){if(desktop.exitCode!==null)throw new Error('Temporary M4 App exited');try{return await call<WorkerStatus>('status');}catch{await wait(100);}}throw new Error('Temporary M4 App not ready');};
const stop=async()=>{desktop?.kill('SIGTERM');for(let i=0;i<100;i++){try{await callWorker(dir,'status',undefined,100);}catch{if(!await stat(dir+'.lock').then(()=>true,()=>false))return;}await wait(100);}throw new Error('Temporary M4 App did not release Worker');};
try{
  let store=new Store(dir);const base=prepare(store,config);store.updateConfig({bossReadOnlyConsent:true});saveEnvironment(`${dir}/.env`,{...config,clearKey:false});
  const fakeStatus=()=>({milestone:'M4',llm:{configured:true,sessionReady:true},browser:{open:false},mode:'preview'} as WorkerStatus),service=new DataService(store,dir,fakeStatus),backup=await service.backup();
  store.upsertJob({...base,id:'demo:after_backup',platformJobId:'after_backup'});const snapshot={id:'boss-chat:post_backup_refused',recruiterId:'post_backup_refused',recruiterAliases:['post_backup_refused','opaque_post_backup~~']};store.db.prepare("INSERT INTO chat_conversations(id,recruiter_id,name,company,state,reason,snapshot_json,updated_at) VALUES(?,?,'匿名招聘人','匿名公司','REJECTED','匿名拒绝',?,?)").run(snapshot.id,snapshot.recruiterId,JSON.stringify(snapshot),new Date().toISOString());
  const plan=await service.prepareRestore(backup.path);await service.commitRestore(plan.id);store.close();
  const ready=await start();assert.equal(ready.milestone,'M4');assert.equal(ready.llm.sessionReady,true);assert.equal((await call('config.get')).bossReadOnlyConsent,false);assert.equal((await call('send.status')).policy.liveEnabled,false);assert.equal((await call('chat.list')).autoEnabled,false);assert.equal((await call('jobs.list')).total,1);assert.equal((await call('resume.list')).approvedCount,2);assert.equal((await call('data.status')).pendingOperation,null);assert.equal((await call('data.status')).operationError,null);
  const db=new DatabaseSync(`${dir}/jobpilot.sqlite`,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) n FROM contact_locks WHERE kind='rejected'").get()!.n,2);}finally{db.close();}
  const node=`${app}/Contents/MacOS/jobpilot-node`,script=`${app}/Contents/Resources/worker/index.mjs`;
  for(let index=0;index<2;index++){const client=new Client({name:`m4-compat-${index}`,version:'0.0.1'});clients.push(client);await client.connect(new StdioClientTransport({command:node,args:[script,'--mode','mcp','--data-dir',dir],env:{PATH:'/usr/bin:/bin'}}));await client.ping();assert.equal(client.getServerVersion()?.version,version);const tools=await client.listTools();assert.equal(tools.tools.length,10);const result=await client.callTool({name:'jobpilot.status',arguments:{}});assert.equal(JSON.parse((result.content[0] as any).text).data.pid,ready.pid);const blocked=await client.callTool({name:'jobpilot.start_run',arguments:{profileId:'primary',mode:'auto'}});assert.equal(JSON.parse((blocked.content[0] as any).text).error.code,'CONSENT_REQUIRED');}
  await Promise.all(clients.map(client=>client.close()));clients=[];await stop();
  await mkdir(`${dir}/chrome-profile`,{recursive:true});await writeFile(`${dir}/chrome-profile/anonymous-cookie`,'anonymous-cookie');await writeFile(`${dir}/data-operation.json`,JSON.stringify({kind:'reset',id:randomUUID()}),{mode:0o600});
  const empty=await start();assert.equal(empty.llm.configured,false);assert.equal((await call('jobs.list')).total,0);assert.equal((await call('resume.list')).facts.length,0);assert.equal((await call('send.outbox')).total,0);assert.equal((await call('chat.outbox')).items.length,0);for(const name of ['.env','chrome-profile'])await assert.rejects(stat(`${dir}/${name}`),{code:'ENOENT'});await stop();
  console.log('PASS: shipped M4 App applies a confirmed restore before startup, preserves later refusal locks, disables grants, reloads the existing env, shares one Worker with two MCP clients, and applies full reset at restart. Synthetic data only; no BOSS access or messages.');
}finally{await Promise.allSettled(clients.map(client=>client.close()));desktop?.kill('SIGTERM');await callWorker(dir,'shutdown',undefined,1000).catch(()=>{});await wait(1500);await rm(dir,{recursive:true,force:true});}
