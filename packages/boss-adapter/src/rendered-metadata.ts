// Read only narrowly named metadata already supplied to the currently rendered component.
// No stores, auth/security fields, arbitrary object traversal, network calls or serialization.
import {businessId as id,recruiterIdentity} from './business-id.js';
function componentInputs(element:Element){
  const inputs:any[]=[];let node:Element|null=element;for(let depth=0;node&&depth<4&&node!==document.body;depth++,node=node.parentElement){const instance=(node as any).__vue__??(node as any).__vueParentComponent?.proxy;if(instance)inputs.push(instance.$props,instance.$data);}
  return inputs.filter(value=>value&&typeof value==='object');
}
export function renderedJobIdentity(element:Element,expectedJobId:string){
  for(const data of componentInputs(element))for(const key of ['jobInfo','jobDetail']){
    const job=data[key];if(!job||typeof job!=='object')continue;
    if(id(job.encryptJobId??job.encryptId??job.jobId)!==expectedJobId)continue;
    const boss=data.bossInfo??job.bossInfo;
    const recruiterId=id(job.encryptBossId??boss?.encryptBossId??boss?.encryptId);if(recruiterId)return {jobId:expectedJobId,recruiterId};
  }
  return null;
}
export function renderedChatIdentity(element:Element,displayedName:string){
  if(!displayedName)return null;
  for(const data of componentInputs(element)){
    const boss=data.bossInfo??data.chatUser;if(!boss||(boss.name??boss.bossName)!==displayedName)continue;
    const identity=recruiterIdentity(boss);if(identity)return {...identity,jobId:id(data.jobInfo?.encryptJobId??data.jobInfo?.jobId)};
  }
  return null;
}
export function renderedMessageId(element:Element){
  for(const data of componentInputs(element)){const message=data.message??data.item??data.messageInfo;if(message&&typeof message==='object'){const value=id(message.mid??message.messageId);if(value&&!/^(local|temp|pending)/i.test(value))return value;}}
  return null;
}

export function renderedHistoryComplete(element:Element){return componentInputs(element).some(data=>data.hasMoreHistory===false||data.historyHasMore===false||data.allHistoryLoaded===true);}

// Diagnostic names only: never includes component values, message text or authentication fields.
export function renderedStructure(element:Element){
  let node:Element|null=element;const result=[];
  for(let depth=0;node&&depth<4&&node!==document.body;depth++,node=node.parentElement){
    const instance=(node as any).__vue__??(node as any).__vueParentComponent?.proxy;
    result.push({className:node.className,component:instance?.$options?.name??null,keys:[...new Set([instance?.$props,instance?.$data].filter(Boolean).flatMap(value=>Object.keys(value)))].filter(key=>/^(job|boss|chat|message|msg|item|has|history|allHistory|load|user|friend|list)/i.test(key)&&!/token|auth|security|cookie|password/i.test(key)).slice(0,40)});
  }
  return result;
}
