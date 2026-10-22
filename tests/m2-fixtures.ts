import {createServer,type IncomingHttpHeaders} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Store} from '@jobpilot/store';
import type {LlmConfiguration} from '@jobpilot/contracts';
import {demoJobs} from '../fixtures/boss/demo-jobs.js';
export const mapFact='在 Welgoo 扫地机器人项目中，负责地图协议解析与点云渲染。';
export const sdkFact='摄像头项目仅集成 P2P SDK，未独立实现协议栈或内核。';
type Handler=(body:any,calls:number,headers:IncomingHttpHeaders)=>unknown|Promise<unknown>;
export async function withModel(handler:Handler,run:(config:LlmConfiguration,calls:()=>number)=>Promise<void>){
  let calls=0;const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;try{const body=JSON.parse(raw);const answer=await handler(body,++calls,req.headers);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:typeof answer==='string'?answer:JSON.stringify(answer)},finish_reason:'stop'}]}));}catch{res.writeHead(500);res.end('{}');}});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const config={baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'anonymous-fixture',timeoutMs:1000,allowLan:false,apiKey:'anonymous-key-never-persist'};
  try{await run(config,()=>calls);}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
export function goodResponse(body:any){
  const input=JSON.parse(body.messages[1].content);
  if(input.statements)return {opening:'direction',statementIds:[input.statements[0].id],closing:'team'};
  const fact=input.approvedFacts.find((f:any)=>f.text.includes('Welgoo'))??input.approvedFacts[0];
  return {score:90,decision:'RECOMMEND',strengths:[{requirement:'地图协议与点云渲染',factId:fact.factId,reason:fact.text}],gaps:[],evidenceFactIds:[fact.factId]};
}
export function prepare(store:Store,config:LlmConfiguration){
  store.importFacts('anonymous-m2.txt',randomUUID(),[mapFact,sdkFact].map((text,index)=>({text,category:'project',source:{file:'anonymous-m2.txt',kind:'text',paragraph:index+1,quote:text}})));
  for(const fact of store.resume().facts)store.updateFact({id:fact.id,expectedVersion:fact.version,approved:true});
  store.freezeResume(store.resume().version);
  const {apiKey,...settings}=config;store.updateConfig({llm:settings});
  const job={...demoJobs()[0],title:'iOS 扫地机器人地图研发',jdText:'负责 iOS Swift 扫地机器人客户端，地图协议解析与点云渲染。',jdHash:'map-fixture-v1'};
  store.upsertJob(job);return job;
}
