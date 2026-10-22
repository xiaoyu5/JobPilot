import {MatchingService} from '@jobpilot/core';
import type {Store} from '@jobpilot/store';
import type {LlmConfiguration} from '@jobpilot/contracts';
import {prepare} from './m2-fixtures.js';
export async function seedSendQueue(store:Store,config:LlmConfiguration,count=2){
  const base=prepare(store,config);store.updateConfig({bossReadOnlyConsent:true});const matching=new MatchingService(store,()=>config),items=[];
  for(let i=0;i<count;i++){
    const job={...base,id:`boss:anonymous_send_${i}`,platformJobId:`anonymous_send_${i}`,source:'boss' as const,title:`匿名待发岗位 ${i+1}`,recruiterId:`anonymous_recruiter_${i}`,url:`https://www.zhipin.com/job_detail/anonymous_send_${i}.html`};store.upsertJob(job);
    await matching.analyze(job.id,new AbortController().signal);const draft=await matching.generate(job.id,'natural',new AbortController().signal);const queue=matching.queue(job.id,draft.id);matching.review(queue.queueItemId,1);items.push({job,draft,queueId:queue.queueItemId});
  }
  return items;
}
