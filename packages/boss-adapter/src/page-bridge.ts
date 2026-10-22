import {conversationRoot,visibleMessages} from './conversation.js';
import {renderedJobIdentity,renderedChatIdentity,renderedHistoryComplete,renderedStructure} from './rendered-metadata.js';
import {contactEntries,communicationIdentity} from './communication.js';
import {businessId,recruiterIdentity} from './business-id.js';

// Chrome extension activeTab action, MAIN world. No network, storage, cookies, input or clicks.
// Only publish business identifiers that are bound to the currently rendered job/name.
export function connectReadOnlyBridge(){
const key='__JobPilotReadonlyBridge_v1__',own=window as unknown as Record<string,any>;
if(location.origin!=='https://www.zhipin.com')throw new Error('Only BOSS is supported');
own[key]?.stop();
const owned=new Map<Element,Map<string,string|null>>();
const knownRecruiters=new Set<string>();
let indicator:HTMLElement|undefined;
function set(node:Element,name:string,value:string){let attrs=owned.get(node);if(!attrs){attrs=new Map();owned.set(node,attrs);}if(!attrs.has(name)){if(node.hasAttribute(name))return;attrs.set(name,null);}node.setAttribute(name,value);}
function restore(){for(const [node,attrs] of owned)for(const [name,value] of attrs){if(value===null)node.removeAttribute(name);else node.setAttribute(name,value);}owned.clear();}
function bossInput(element:Element,name:string,root:Element){
  let node:Element|null=element;
  for(let depth=0;node&&depth<4&&node!==document.body;depth++,node=node.parentElement){
    const instance=(node as any).__vue__??(node as any).__vueParentComponent?.proxy;
    for(const input of [instance?.$props,instance?.$data]){
      if(!input||typeof input!=='object')continue;
      for(const field of Object.keys(input).filter(key=>/^(is|has|noMore|more|all|load)/i.test(key)&&!/token|auth|security|cookie|password/i.test(key)).slice(0,25))set(root,'data-jobpilot-field-'+field.replace(/[^a-z0-9_-]/gi,'-').toLowerCase(),'');
      const boss=input.boss;if(!boss||typeof boss!=='object')continue;
      for(const field of Object.keys(boss).filter(key=>!/token|auth|security|cookie|password/i.test(key)).slice(0,35))set(root,'data-jobpilot-bossfield-'+field.replace(/[^a-z0-9_-]/gi,'-').toLowerCase(),'');
      const candidateName=boss.name??boss.bossName;
      set(root,'data-jobpilot-boss-name-'+(typeof candidateName==='string'&&candidateName.trim()===name?'matched':'unmatched'),'');
      if(!name)set(root,'data-jobpilot-visible-name-missing','');
      for(const field of ['encryptBossId','encryptUserId','encryptUid','encryptId','bossId','uid'])set(root,'data-jobpilot-id-'+field.toLowerCase()+'-'+(businessId(boss[field])?'valid':'unavailable'),'');
      if(!name||typeof candidateName!=='string'||candidateName.trim()!==name)continue;
      const identity=recruiterIdentity(boss);
      if(identity)return {...identity,jobId:businessId(boss.encryptJobId??input.jobInfo?.encryptJobId)};
    }
  }
  return null;
}
function recordHistoryComplete(record:Element,name:string,recruiterId:string){
  // The rendered main chat component distinguishes initial/reset state from a
  // successfully loaded final page with isToTop. Never infer completion from
  // loading=false or history=false alone, or inspect a store/request object.
  if(!record.matches('.chat-record'))return false;
  const instance=(record as any).__vue__??(record as any).__vueParentComponent?.proxy;
  const data=instance?.$data,boss=data?.boss,nameValue=boss?.name??boss?.bossName;
  if(!data||!boss||typeof boss!=='object'||typeof nameValue!=='string'||nameValue.trim()!==name)return false;
  const currentId=recruiterIdentity(boss)?.recruiterId;
  const messages=visibleMessages(record),count=record.querySelectorAll('.message-item,.chat-message-item,[data-message-id]').length;
  return currentId===recruiterId&&data.history===false&&data.loading===false&&data.isToTop===true&&/^[1-9]\d{0,29}$/.test(String(data.msgMinId))&&count>0&&count<=100&&messages.length===count&&messages.every(message=>message.confirmed);
}
function publishKnownContacts(){
  for(const entry of [...document.querySelectorAll('.chat-user .friend-content')].filter(node=>node.getClientRects().length>0).slice(0,100)){
    const name=entry.querySelector('.name-text')?.textContent?.trim();if(!name)continue;
    const ids=new Set<string>();let node:Element|null=entry;
    for(let depth=0;node&&depth<4&&node!==document.body;depth++,node=node.parentElement){
      const instance=(node as any).__vue__??(node as any).__vueParentComponent?.proxy;
      const source=instance?.$props?.source;if(!source||typeof source!=='object'||typeof source.name!=='string'||source.name.trim()!==name)continue;
      const id=recruiterIdentity(source)?.recruiterId;if(id)ids.add(id);
    }
    if(ids.size!==1)continue;const id=[...ids][0];if(!knownRecruiters.has(id))continue;
    set(entry,'data-boss-id',id);set(entry,'data-jobpilot-chat-target-name',name);
  }
}
function refresh(){
  restore();
  const job=location.pathname.match(/^\/job_detail\/([A-Za-z0-9_-]+)\.html$/)?.[1];
  if(job)for(const root of document.querySelectorAll('.job-banner,.job-detail')){const id=renderedJobIdentity(root,job);if(id){set(root,'data-boss-id',id.recruiterId);set(root,'data-job-id',id.jobId);}}
  if(job)for(const entry of contactEntries()){
    set(entry,'data-jobpilot-identity-candidates-'+communicationIdentity().recruiterIds.length,'');
    try{const value=entry.getAttribute('redirect-url');if(!value)continue;const link=new URL(value,location.origin);if(link.origin!==location.origin||link.pathname!=='/web/geek/chat'||link.searchParams.get('jobId')!==job)continue;
      const candidate=link.searchParams.get('id')??'';
      set(entry,'data-jobpilot-redirect-id-length-'+candidate.length,'');
      set(entry,'data-jobpilot-redirect-id-'+(businessId(candidate)?'valid':'invalid'),'');
      if(/^[1-9]\d*$/.test(candidate))set(entry,'data-jobpilot-redirect-id-numeric','');
      if(candidate.includes('~'))set(entry,'data-jobpilot-redirect-id-tilde','');
      if(candidate.includes('='))set(entry,'data-jobpilot-redirect-id-padding','');
      if(/[^A-Za-z0-9_~=-]/.test(candidate))set(entry,'data-jobpilot-redirect-id-other-punctuation','');
    }catch{}
  }
  const root=conversationRoot();if(!root){indicator?.remove();indicator=undefined;return;}
  set(root,'data-jobpilot-reader-connected','true');
  set(root,'data-jobpilot-reader-boss-adapter','true');
  const headers=[root,...root.querySelectorAll('.top-info-content,.user-info-wrap,.chat-position-content')].slice(0,5);
  const candidates=[...headers,...root.querySelectorAll('.chat-record')].slice(0,6);
  const diagnostics=candidates.flatMap(renderedStructure);
  for(const field of new Set(diagnostics.flatMap(row=>row.keys)))set(root,'data-jobpilot-field-'+field.replace(/[^a-z0-9_-]/gi,'-').toLowerCase(),'');
  const name=root.querySelector('.boss-name,.chat-user-name,.opponent-name,.top-info-content .name-text')?.textContent?.trim()??'';
  const found=candidates.map(node=>renderedChatIdentity(node,name)??bossInput(node,name,root)).filter(value=>!!value);const ids=new Set(found.map(value=>value.recruiterId));
  const id=found.find(value=>[...ids].every(candidate=>value.aliases.includes(candidate)))??null;
  set(root,'data-jobpilot-identity-count-'+ids.size,'');
  if(!indicator||indicator.parentElement!==root){indicator?.remove();indicator=document.createElement('aside');indicator.className='jobpilot-readonly-indicator';indicator.setAttribute('role','status');indicator.style.cssText='background:#e0f2fe;color:#164e63;padding:6px 12px;font:12px system-ui;pointer-events:none';root.prepend(indicator);}
  const label=id?'JobPilot 只读连接已启用 · 招聘人已绑定':'JobPilot 只读连接已启用 · 招聘人标识待识别';if(indicator.textContent!==label)indicator.textContent=label;
  if(!id)return;
  if(knownRecruiters.size<100)knownRecruiters.add(id.recruiterId);
  set(root,'data-boss-id',id.recruiterId);set(root,'data-jobpilot-recruiter-aliases',JSON.stringify(id.aliases));if(id.jobId)set(root,'data-job-id',id.jobId);
  const record=root.querySelector('.chat-record,.chat-message-list');if(record&&(renderedHistoryComplete(record)||recordHistoryComplete(record,name,id.recruiterId)))set(record,'data-history-complete','true');
  publishKnownContacts();
}
refresh();
let pending:ReturnType<typeof setTimeout>|undefined;
const observer=new MutationObserver(()=>{if(pending)clearTimeout(pending);pending=setTimeout(refresh,100);});
observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
const timer=setInterval(refresh,1000);
own[key]={stop(){observer.disconnect();clearInterval(timer);if(pending)clearTimeout(pending);restore();indicator?.remove();delete own[key];}};
const root=conversationRoot();
const result={connected:true,chatIdentityPublished:!!root?.getAttribute('data-boss-id'),jobIdentityPublished:!!document.querySelector('.job-banner[data-boss-id]'),structure:[...document.querySelectorAll('.job-banner,.job-detail,.chat-conversation,.chat-record')].slice(0,6).map(renderedStructure)};
// This is the only returned value; no identifiers, messages, names or credentials.
return result;
}
