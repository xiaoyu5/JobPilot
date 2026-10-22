import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {Store} from '@jobpilot/store';
import type {Assessment,Draft,Envelope,LlmConfiguration} from '@jobpilot/contracts';
import {callWorker} from '../packages/worker/src/client.js';
import {withModel,goodResponse,prepare,mapFact} from '../tests/m2-fixtures.js';
const live=process.argv.includes('--live');
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function smoke(config:LlmConfiguration){
  const dir=await mkdtemp('/tmp/jp-m2-smoke-'),store=new Store(dir),job=prepare(store,config);
  const backend={...job,id:'demo:backend',platformJobId:'backend',title:'Python 后端工程师',jdText:'Django 纯后端微服务开发',jdHash:'backend'};store.upsertJob(backend);store.close();
  const node=resolve('apps/desktop/src-tauri/binaries/jobpilot-node-aarch64-apple-darwin'),script=resolve('dist/worker/index.mjs');
  let worker=spawn(node,[script,'--mode','worker','--data-dir',dir],{stdio:['ignore','ignore','inherit'],env:{...process.env,NODE_OPTIONS:'',NODE_PATH:'',OPENAI_API_KEY:''}}),client:Client|undefined;
  const call=async<T>(action:Parameters<typeof callWorker>[1],payload?:unknown)=>{const result=await callWorker(dir,action,payload);assert(result.ok,JSON.stringify(result.error));return result.data as T;};
  const ready=async()=>{for(let i=0;i<100;i++){try{if((await callWorker(dir,'status',undefined,300)).ok)return;}catch{}await wait(100);}throw new Error('Worker not ready');};
  try{
    await ready();await call('llm.env.save',config);
    client=new Client({name:'jobpilot-m2-check',version:'0.2.0'});await client.connect(new StdioClientTransport({command:node,args:[script,'--mode','mcp','--data-dir',dir]}));
    const tools=await client.listTools();assert.equal(tools.tools.length,10);
    const invoke=async<T>(name:string,args:Record<string,unknown>)=>{const reply=await client!.callTool({name,arguments:args});const envelope=JSON.parse((reply.content[0] as any).text) as Envelope<T>;assert(envelope.ok,JSON.stringify(envelope.error));return envelope.data!;};
    const report=await invoke<Assessment>('jobpilot.analyze',{jobId:job.id});console.log(JSON.stringify({stage:'analyze',decision:report.decision,score:report.score,reasons:report.reasons,gaps:report.gaps}));assert(report.score!==null,'model must return a valid evidence-checked report');assert(['RECOMMEND','REVIEW'].includes(report.decision));assert(report.strengths.some(s=>s.reason===mapFact));
    const draft=await invoke<Draft>('jobpilot.draft_greeting',{jobId:job.id});assert.equal(draft.audit.status,'PASS',JSON.stringify(draft.audit));assert(draft.content.includes(mapFact));
    const queue=await invoke<{queueItemId:string}>('jobpilot.queue',{jobId:job.id,draftId:draft.id});assert(queue.queueItemId);
    const {runId}=await invoke<{runId:string}>('jobpilot.dry_run',{source:'demo',maxJobs:2});
    for(let i=0;i<100;i++){const run=await call<any>('run.get',{id:runId});if(!['ANALYZING','DRAFTING'].includes(run.state)){assert.equal(run.state,'COMPLETED');assert.equal(run.processedCount,2);assert.equal(run.skippedCount,1);break;}await wait(100);}
    assert.equal((await call<any>('run.get',{id:runId})).state,'COMPLETED');
    const filtered=await invoke<any>('jobpilot.list_jobs',{status:report.decision,minScore:report.score!});assert.equal(filtered.total,1);
    await assert.rejects(async()=>{const r=await callWorker(dir,'run.start',{profileId:'primary',mode:'auto'});if(!r.ok)throw Object.assign(new Error(),{code:r.error?.code});},{code:'CONSENT_REQUIRED'});
    await client.close();client=undefined;await call('shutdown');await new Promise(r=>worker.once('exit',r));
    worker=spawn(node,[script,'--mode','worker','--data-dir',dir],{stdio:['ignore','ignore','inherit']});await ready();
    assert.equal((await call<any>('queue.list')).items[0].draft.id,draft.id);
    assert.equal((await call<Assessment>('analysis.analyze',{jobId:job.id})).id,report.id,'persistent cache does not call provider again');
    assert.equal((await readFile(`${dir}/jobpilot.sqlite`)).includes(config.apiKey??'impossible-fixture-marker'),false);
    console.log(JSON.stringify({result:'PASS',provider:live?'live Cockpit':'anonymous HTTP fixture',model:config.model,assessment:{decision:report.decision,score:report.score,evidenceCount:report.evidenceFactIds.length},greeting:{audit:draft.audit.status,length:[...draft.content].length},mcpTools:tools.tools.length,dryRun:'COMPLETED',sent:0,persistentCache:true}));
  }finally{
    await client?.close();await callWorker(dir,'shutdown',undefined,2000).catch(()=>{});if(worker.exitCode===null)await Promise.race([new Promise(r=>worker.once('exit',r)),wait(3000)]);if(worker.exitCode===null)worker.kill();await rm(dir,{recursive:true,force:true});
  }
}
if(live){process.loadEnvFile('.env.local');assert(process.env.OPENAI_BASE_URL&&process.env.OPENAI_MODEL);await smoke({baseUrl:process.env.OPENAI_BASE_URL,model:process.env.OPENAI_MODEL,apiKey:process.env.OPENAI_API_KEY,timeoutMs:60000,allowLan:false});}
else await withModel(goodResponse,config=>smoke(config));
