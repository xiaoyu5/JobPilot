import {AppError,type JobRecord,type SearchProfileData} from '@jobpilot/contracts';
import {normalizeCard,extractSearchDom} from './dom.js';
type Page={cards?:ReturnType<typeof extractSearchDom>;empty?:boolean};
export async function collectSearchPages(profile:SearchProfileData,signal:AbortSignal,read:()=>Promise<Page>,scroll:()=>Promise<unknown>,next:()=>Promise<boolean>,onJob:(job:JobRecord)=>void){
 const seen=new Set<string>();let page=await read();
 for(let p=0;p<(profile.maxPages??1);p++){
  for(let attempt=0;attempt<(profile.maxScrolls??4);attempt++){
   signal.throwIfAborted();for(const raw of page.cards??[]){const job=normalizeCard(raw);if(!seen.has(job.id)){seen.add(job.id);onJob(job);if(seen.size>=profile.maxJobs)return seen.size;}}
   if(page.empty||attempt+1>=(profile.maxScrolls??4))break;
   await scroll();signal.throwIfAborted();page=await read();
  }
  if(p+1>=(profile.maxPages??1)||!await next())break;
  signal.throwIfAborted();page=await read();
 }
 if(!seen.size&&!page.empty)throw new AppError('ADAPTER_CHANGED','未识别到岗位卡片或明确空结果，已停止读取。');return seen.size;
}
