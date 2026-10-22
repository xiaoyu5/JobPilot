import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { callWorker } from '../packages/worker/src/client.js';
import { docxFixture, pdfFixture } from '../tests/fixtures.js';
import type { AppConfig, ResumeState, SearchProfileData } from '@jobpilot/contracts';

const dir=await mkdtemp('/tmp/jp-m1-');
const node=resolve('apps/desktop/src-tauri/binaries/jobpilot-node-aarch64-apple-darwin'),script=resolve('dist/worker/index.mjs');
let processWorker:ChildProcess|undefined,client:Client|undefined;
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function call<T>(action:Parameters<typeof callWorker>[1],payload?:unknown):Promise<T>{const result=await callWorker(dir,action,payload);assert(result.ok,JSON.stringify(result.error));return result.data as T;}
async function launch(){processWorker=spawn(node,[script,'--mode','worker','--data-dir',dir],{stdio:['ignore','ignore','inherit'],env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}});for(let i=0;i<100;i++){try{await call('status');return;}catch{}await wait(100);}throw new Error('Worker not ready');}
async function stop(){await call('shutdown');for(let i=0;i<50&&processWorker?.exitCode===null;i++)await wait(100);assert.notEqual(processWorker?.exitCode,null,'Worker should exit cleanly');}
async function runDone(id:string){for(let i=0;i<100;i++){const run=await call<any>('run.get',{id});if(run.state!=='DISCOVERING'){assert.equal(run.state,'COMPLETED');return;}await wait(50);}throw new Error('Run did not complete');}
try{
  await launch();
  let resume=await call<ResumeState>('resume.import',{path:await docxFixture(dir)});assert.equal(resume.approvedCount,0);
  resume=await call<ResumeState>('resume.import',{path:await pdfFixture(dir)});assert(resume.facts.some(fact=>fact.source.kind==='pdf'&&fact.source.page===1));
  const first=resume.facts.find(fact=>fact.category==='skill')!;
  resume=await call<ResumeState>('resume.update',{id:first.id,expectedVersion:first.version,approved:true});
  resume=await call<ResumeState>('resume.freeze',{expectedVersion:resume.version});assert.equal(resume.approvedCount,1);
  await call('config.update',{llm:{baseUrl:'http://localhost:1/v1',model:'anonymous-fixture',timeoutMs:1000,allowLan:false}});
  await call('search.save',{id:'primary',name:'匿名集成验证',keyword:'Swift',searchUrl:'',maxJobs:7});
  for(let i=0;i<2;i++)await runDone((await call<{runId:string}>('demo.load')).runId);
  assert.equal((await call<any>('jobs.list',{})).total,20);
  await stop();await launch();
  assert.equal((await call<AppConfig>('config.get')).llm?.model,'anonymous-fixture');
  assert.equal((await call<SearchProfileData>('search.get')).maxJobs,7);
  const restored=await call<ResumeState>('resume.list');assert.equal(restored.version,resume.version);assert.equal(restored.frozenVersion,resume.frozenVersion);assert.equal(restored.approvedCount,1);
  assert.equal((await call<any>('jobs.list',{source:'boss'})).total,0);
  assert.equal((await call<any>('jobs.list',{source:'demo'})).total,20);
  client=new Client({name:'jobpilot-m1-check',version:'0.1.0'});
  await client.connect(new StdioClientTransport({command:node,args:[script,'--mode','mcp','--data-dir',dir]}));await client.ping();
  const jobs=await client.callTool({name:'jobpilot.list_jobs',arguments:{source:'demo',limit:30}});
  assert.equal(JSON.parse((jobs.content[0] as {text:string}).text).data.total,20);
  const auto=await client.callTool({name:'jobpilot.start_run',arguments:{profileId:'primary',mode:'auto'}});
  assert.equal(JSON.parse((auto.content[0] as {text:string}).text).error.code,'CONSENT_REQUIRED');
  console.log('PASS: packaged Node + SQLite + bounded DOCX/PDF parsing + review/freeze + deduplication + persisted restart + MCP shared data + Auto denial');
}finally{
  await client?.close();await callWorker(dir,'shutdown',undefined,2000).catch(()=>{});
  for(let i=0;i<30&&processWorker?.exitCode===null;i++)await wait(100);
  if(processWorker?.exitCode===null)processWorker.kill('SIGTERM');
  await rm(dir,{recursive:true,force:true});
}
