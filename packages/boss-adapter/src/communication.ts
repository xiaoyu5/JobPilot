import {renderedJobIdentity} from './rendered-metadata.js';
import {conversationRoot,conversationSnapshot} from './conversation.js';
import {businessId as validId} from './business-id.js';
// Visible DOM, links and narrowly bound rendered business metadata. No credentials or requests.
const visible=(element:Element)=>element.getClientRects().length>0;
const text=(element:Element|null)=>element?.textContent?.trim()??'';
const unique=(values:(string|null)[])=>[...new Set(values.filter((value):value is string=>!!value))];
export function communicationIdentity(){
  const chat=conversationRoot();
  if(chat){const current=conversationSnapshot(),pathJob=location.pathname.match(/^\/job_detail\/([A-Za-z0-9_-]+)\.html$/)?.[1];return current?.identityBound?{jobIds:current.jobId?[current.jobId]:pathJob?[pathJob]:[],recruiterIds:[current.recruiterId]}:{jobIds:[],recruiterIds:[]};}
  const roots=chat?[chat]:[...document.querySelectorAll('.job-detail,.job-banner,.boss-info,.job-boss-info,.greet-dialog,.greeting-dialog')];
  const recruiterIds:string[]=[];const jobIds:string[]=[];
  for(const root of roots){
    const nodes=[root,...root.querySelectorAll('[data-boss-id],[data-bossid],[data-encrypt-boss-id],[data-job-id],a[href]')].filter(node=>visible(node)&&!node.closest('.more-job-section,.recommend-list,.job-card-wrapper,.job-card-box'));
    for(const node of nodes){
      for(const attribute of ['data-boss-id','data-bossid','data-encrypt-boss-id']){const id=validId(node.getAttribute(attribute));if(id)recruiterIds.push(id);}
      const jobId=validId(node.getAttribute('data-job-id'));if(jobId)jobIds.push(jobId);
      if(node instanceof HTMLAnchorElement){try{const url=new URL(node.href);if(url.origin!==location.origin)continue;for(const key of ['bossId','encryptBossId']){const id=validId(url.searchParams.get(key));if(id)recruiterIds.push(id);}const bossPath=url.pathname.match(/^\/boss_detail\/([A-Za-z0-9_~-]+)\.html$/);if(bossPath)recruiterIds.push(bossPath[1]);}catch{}}
    }
  }
  const path=location.pathname.match(/^\/job_detail\/([A-Za-z0-9_-]+)\.html$/);
  if(path){jobIds.push(path[1]);for(const root of document.querySelectorAll('.job-detail,.job-banner')){if(!visible(root))continue;const bound=renderedJobIdentity(root,path[1]);if(bound)recruiterIds.push(bound.recruiterId);}
    for(const entry of contactEntries())for(const attribute of ['data-url','redirect-url']){try{
      const value=entry.getAttribute(attribute);if(!value)continue;const link=new URL(value,location.origin);
      if(link.origin!==location.origin||link.pathname!=='/web/geek/chat')continue;
      const jobId=validId(link.searchParams.get('jobId')??link.searchParams.get('encryptJobId'));
      if(jobId!==path[1])continue;
      for(const key of ['bossId','encryptBossId','id']){const id=validId(link.searchParams.get(key));if(id)recruiterIds.push(id);}
    }catch{}}
  }
  if(location.pathname==='/web/geek/chat'){const url=new URL(location.href);for(const key of ['jobId','encryptJobId']){const id=validId(url.searchParams.get(key));if(id)jobIds.push(id);}for(const key of ['bossId','encryptBossId','id']){const id=validId(url.searchParams.get(key));if(id)recruiterIds.push(id);}}
  const current=conversationSnapshot();if(current?.identityBound){recruiterIds.push(current.recruiterId);if(current.jobId)jobIds.push(current.jobId);}
  return {jobIds:unique(jobIds),recruiterIds:unique(recruiterIds)};
}
export function contactEntries(){
  const banners=[...document.querySelectorAll('.job-banner')].filter(visible);
  const roots=banners.length?banners:[...document.querySelectorAll('.job-detail')].filter(visible);
  return [...new Set(roots.flatMap(root=>[...root.querySelectorAll<HTMLElement>('a,button')]))].filter(node=>visible(node)&&!node.closest('.more-job-section,.job-card-wrapper,.job-card-box,.recommend-list')&&/^(立即沟通|继续沟通|已沟通)$/.test(text(node)));
}
export function composer(){
  const scopes=[...document.querySelectorAll<HTMLElement>('.greet-dialog,.greeting-dialog,.greet-dialog-wrap,.chat-conversation,.chat-content,.chat-box')].filter(visible);
  const pairs=scopes.flatMap(scope=>[...scope.querySelectorAll<HTMLElement>('textarea,[contenteditable="true"]')].filter(visible).map(input=>({scope,input})));
  const uniqueInputs=[...new Map(pairs.map(pair=>[pair.input,pair])).values()];if(uniqueInputs.length!==1)return null;
  const pair=uniqueInputs[0],buttons=[...pair.scope.querySelectorAll<HTMLElement>('button,a[role="button"],.btn-send')].filter(node=>visible(node)&&/^(发送|发送招呼语)$/.test(text(node)));
  if(buttons.length===1)return {...pair,button:buttons[0],sendBy:'button' as const};
  if(!buttons.length&&/按\s*Enter\s*键发送/i.test(pair.scope.textContent??''))return {...pair,button:null,sendBy:'enter' as const};
  return null;
}
export function communicationInfo(){
  const identity=communicationIdentity(),editor=composer(),entries=contactEntries();
  const preview=[...document.querySelectorAll<HTMLElement>('button[aria-controls],a[role="button"][aria-controls]')].filter(node=>visible(node)&&/^(编辑招呼语|填写招呼语|写招呼语)$/.test(text(node))&&!!document.getElementById(node.getAttribute('aria-controls')??''));
  const existing=entries.some(node=>/^(继续沟通|已沟通)$/.test(text(node))),chat=conversationSnapshot();
  const alreadyContacted=existing||!!chat?.messages.some(message=>message.direction!=='system');
  const entryKind=entries.length>1?'ambiguous':existing?'continue-chat':entries.length===1?'instant-send':editor?'editable':preview.length===1?'edit-preview':'unknown';
  const message=entryKind==='instant-send'?'首次点击立即沟通会自动发送平台默认招呼，随后再发已确认的 AI 文案，共两条。':entryKind==='continue-chat'?'已沟通过：继续沟通只进入已有会话，应由聊天回复流程处理，不重复首联。':editor?'已找到可见文案编辑框。':preview.length===1?'已找到明确的编辑预览入口。':'未识别到唯一可靠的沟通入口。';
  return {...identity,entryKind,composerReady:!!editor,canOpenPreview:preview.length===1,alreadyContacted,entryClasses:entries.slice(0,6).map(node=>({label:text(node),className:node.className,tag:node.tagName})),message};
}
