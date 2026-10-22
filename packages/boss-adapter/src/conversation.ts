import {renderedChatIdentity,renderedMessageId,renderedHistoryComplete} from './rendered-metadata.js';
import {explicitRefusal} from '../../contracts/src/chat-rules.js';
import {businessId as valid} from './business-id.js';
const visible=(node:Element)=>node.getClientRects().length>0;
export function conversationRoot(){
  const excluded='.user-list,.chat-user,.chat-user-list,.contact-list';
  const primary=[...document.querySelectorAll<HTMLElement>('.chat-conversation')].filter(node=>visible(node)&&!node.closest(excluded));
  const candidates=primary.length?primary:[...document.querySelectorAll<HTMLElement>('.chat-box,.chat-record,.chat-message-list,.chat-content')].filter(node=>visible(node)&&!node.closest(excluded));
  const roots=candidates.filter(node=>!candidates.some(other=>other!==node&&other.contains(node)));
  return roots.length===1?roots[0]:null;
}
export function visibleMessages(root:Element){
  const selector='.message-item,.chat-message-item,[data-message-id]';
  return [...root.querySelectorAll<HTMLElement>(selector)].filter(node=>visible(node)&&!node.parentElement?.closest(selector)).slice(-100).map(node=>{
    const outgoing=node.matches('.is-self,.sent,.mine,.item-myself,.message-mine')||!!node.querySelector('.is-self,.item-myself');
    const platformTitle=node.querySelector('.message-card-top-title')?.textContent?.replace(/\s+/g,'')??'';
    const system=node.matches('.system,.message-system,.system-message')||/^你与该职位竞争者PK情况$/i.test(platformTitle);
    const selector='.text,.message-text,.text-content,.message-content .content,.message-card-top-title,.message-card-top-sub-title';
    const body=[...node.querySelectorAll(selector)].filter(element=>!element.querySelector(selector)).map(element=>{const content=element.cloneNode(true) as Element;for(const receipt of content.querySelectorAll('.message-status,.item-time,.message-tip-bar,.message-controls'))receipt.remove();return content.textContent?.trim()??'';}).join('\n');
    const id=node.getAttribute('data-message-id')??node.getAttribute('data-mid')??renderedMessageId(node)??'';
    return {id,direction:system?'system' as const:outgoing?'outgoing' as const:'incoming' as const,text:body.slice(0,4000),confirmed:!!id&&!/^(local|temp|pending)/i.test(id)&&!node.matches('.sending,.pending,.failed,.error')&&!node.querySelector('.sending,.pending,.failed,.error')};
  });
}
export function conversationSnapshot(){
  const root=conversationRoot();if(!root)return null;
  const ids=new Set<string>(),jobs=new Set<string>();
  for(const node of [root,...root.querySelectorAll('[data-boss-id],[data-bossid],[data-encrypt-boss-id],[data-job-id],a[href]')].filter(node=>visible(node)&&!node.closest('.message-item,.chat-message,.chat-record,.chat-message-list,.chat-message-item'))){
    for(const name of ['data-boss-id','data-bossid','data-encrypt-boss-id']){const value=valid(node.getAttribute(name));if(value)ids.add(value);}
    const job=valid(node.getAttribute('data-job-id'));if(job)jobs.add(job);
    if(node instanceof HTMLAnchorElement){try{const url=new URL(node.href);if(url.origin!==location.origin)continue;for(const key of ['bossId','encryptBossId',...(url.pathname==='/web/geek/chat'?['id']:[])]){const id=valid(url.searchParams.get(key));if(id)ids.add(id);}const match=url.pathname.match(/^\/job_detail\/([A-Za-z0-9_-]+)\.html$/);if(match)jobs.add(match[1]);}catch{}}
  }
  const url=new URL(location.href);if(url.pathname==='/web/geek/chat')for(const key of ['jobId','encryptJobId']){const id=valid(url.searchParams.get(key));if(id)jobs.add(id);}
  const displayedName=root.querySelector('.boss-name,.chat-user-name,.opponent-name,.top-info-content .name-text')?.textContent?.trim()??'';const rendered=renderedChatIdentity(root,displayedName);if(rendered){ids.add(rendered.recruiterId);if(rendered.jobId)jobs.add(rendered.jobId);}
  let recruiterAliases:string[]=[];
  try{const values=JSON.parse(root.getAttribute('data-jobpilot-recruiter-aliases')??'[]'),canonical=valid(root.getAttribute('data-boss-id'));if(root.getAttribute('data-jobpilot-reader-connected')==='true'&&canonical&&Array.isArray(values)&&values.length<=7&&values.every(value=>valid(value))&&values.includes(canonical)&&[...ids].every(value=>values.includes(value))){recruiterAliases=[...new Set(values)];ids.clear();ids.add(canonical);}}catch{}
  // A bound current component takes precedence over an old route after an
  // in-place contact switch. URL-only identities remain insufficient.
  if(url.pathname==='/web/geek/chat'&&ids.size&&!recruiterAliases.length)for(const key of ['bossId','encryptBossId','id']){const id=valid(url.searchParams.get(key));if(id)ids.add(id);}
  const recruiterId=ids.size===1?[...ids][0]:'';
  const start=[...root.querySelectorAll('.history-start,.history-end,.no-more-message,[data-history-complete]')].some(node=>visible(node)&&(node.getAttribute('data-history-complete')==='true'||/没有更多消息|已无更多|聊天记录到此/.test(node.textContent??'')));
  return {id:recruiterId?`boss-chat:${recruiterId}`:'',recruiterId,recruiterAliases,jobId:jobs.size===1?[...jobs][0]:null,name:displayedName.slice(0,80),company:root.querySelector('.company-name,.chat-company,.base-info > span:not(.base-title)')?.textContent?.trim().slice(0,120)??'',url:location.origin+location.pathname+(location.pathname==='/web/geek/chat'?'?'+new URLSearchParams([...new URL(location.href).searchParams].filter(([key])=>['bossId','encryptBossId','id','jobId','encryptJobId'].includes(key))).toString():''),identityBound:!!recruiterId&&ids.size===1,historyComplete:(start||renderedHistoryComplete(root))&&root.querySelectorAll('.message-item,.chat-message-item,[data-message-id]').length<=100,messages:visibleMessages(root),capturedAt:new Date().toISOString()};
}
export function conversationRefused(){const root=conversationRoot();return !!root&&visibleMessages(root).some(message=>message.direction!=='outgoing'&&explicitRefusal(message.text));}
