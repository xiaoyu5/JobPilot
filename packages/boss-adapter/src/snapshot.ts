import { extractSearchDom, extractDetailDom } from './extractors.js';
import {conversationSnapshot,conversationRoot} from './conversation.js';
import {communicationInfo} from './communication.js';
import {renderedStructure} from './rendered-metadata.js';
import {startChatDiagnostics} from './start-chat.js';
import {conversationTargets} from './chat-navigation.js';

// Runs through Chrome's documented Apple Events API, without changing browser identity.
export function snapshot() {
  const url = location.origin + location.pathname;
  if (location.origin !== 'https://www.zhipin.com') return {url, state:'UNKNOWN', message:'请打开 BOSS 页面。'};
  const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].some(element => element.getClientRects().length > 0);
  const body = (document.body?.innerText ?? '').slice(0, 60000);
  let state = 'UNKNOWN', message = '未识别到可靠的登录标识，请检查页面。';
  if (visible('iframe[src*="captcha"], .geetest_panel, .verify-slider, #nc_1_wrapper') || /安全验证|请完成验证|操作过于频繁|访问异常|账号.*受限/.test(body)) { state='CHALLENGE';message='页面需要人工安全验证，已停止读取。'; }
  else if (visible('.sign-wrap, .login-register-btn') || /扫码登录|登录\/注册|登录后查看更多/.test(body)) {state='LOGIN_REQUIRED';message='请在专用 Chrome 中手动登录。';}
  else {
    const label=document.querySelector('.nav-figure .label-text, .user-nav .user-name, .header-user .user-name')?.textContent?.trim() ?? '';
    if (visible('.nav-logout') || (label && !/登录|注册/.test(label))) {state='LOGGED_IN';message='页面显示已登录标识。';}
  }
  if(state!=='LOGGED_IN')return {url,state,message};
  const cards=extractSearchDom().slice(0,50),chatTargets=conversationTargets();
  const numericFonts=[...document.querySelectorAll('.salary,.job-salary')].filter(node=>node.getClientRects().length>0).slice(0,5).map(node=>({family:getComputedStyle(node).fontFamily.slice(0,100),privateCodepoints:[...new Set([...(node.textContent??'')].filter(c=>/[\uE000-\uF8FF]/.test(c)).map(c=>c.codePointAt(0)!.toString(16)))]}));
  const filters=Object.fromEntries(['query','city','experience','degree','salary','industry','position','stage','scale','jobType'].flatMap(key=>{const value=new URL(location.href).searchParams.get(key);return value===null?[]:[[key,value]];}));
  const diagnosticRoots=[...document.querySelectorAll('.job-banner .btn-startchat,.job-boss-info'),conversationRoot()].filter((node):node is Element=>!!node&&node.getClientRects().length>0);
  const sidebar=[...document.querySelectorAll('.chat-user .chat-content li')].filter(node=>node.getClientRects().length>0).slice(0,5).map(node=>({className:node.className,attributes:[...node.attributes].map(attr=>({name:attr.name,length:attr.value.length}))}));
  const businessLinks=[...document.querySelectorAll('.job-banner .btn-startchat')].flatMap(node=>['data-url','redirect-url'].flatMap(attribute=>{try{const value=node.getAttribute(attribute);if(!value)return [];const target=new URL(value,location.origin);const jobId=target.searchParams.get('jobId')??target.searchParams.get('encryptJobId');const pathJob=location.pathname.match(/^\/job_detail\/([A-Za-z0-9_-]+)\.html$/)?.[1];const action=new URL(node.getAttribute('data-url')??'',location.origin);return [{attribute,path:target.pathname,keys:[...target.searchParams.keys()],jobIdMatchesCurrentPath:!!jobId&&jobId===pathJob,jobIdMatchesAction:!!jobId&&jobId===action.searchParams.get('jobId'),recruiterIdPresent:!!(target.searchParams.get('id')??target.searchParams.get('bossId')??target.searchParams.get('encryptBossId'))}];}catch{return [];}}));
  const elements=diagnosticRoots.map(root=>[root,...root.querySelectorAll('*')].slice(0,150).map(node=>({tag:node.tagName,className:node.className,attributes:[...node.attributes].filter(attr=>!['class','style','src','alt','title'].includes(attr.name)).map(attr=>({name:attr.name,length:attr.value.length})),component:renderedStructure(node).slice(0,1)})));
  return {url,state,message,readerConnected:document.documentElement.getAttribute('data-jobpilot-reader-connected')==='true'||conversationRoot()?.getAttribute('data-jobpilot-reader-connected')==='true',filters,cards,communication:communicationInfo(),chatTargets,conversation:conversationSnapshot(),detail:extractDetailDom(),empty:visible('.job-list-empty, .search-empty'),structure:{startChat:startChatDiagnostics(),numericFonts,elements,sidebar,businessLinks,queryKeys:[...new URL(location.href).searchParams.keys()],cardLinks:document.querySelectorAll('a[href*="/job_detail/"]').length,classes:[...document.querySelectorAll('[class*="job-card"], [class*="job-detail"], [class*="job-description"]')].slice(0,12).map(element=>element.className),chatClasses:[...document.querySelectorAll('[class*="chat"],[class*="message"],[class*="boss"]')].filter(element=>element.getClientRects().length>0).slice(0,60).map(element=>({tag:element.tagName,className:element.className})),components:[...document.querySelectorAll('.job-banner,.job-detail,.boss-info,.chat-conversation,.chat-box,.chat-record,.chat-message-list,.chat-content,.message-item')].filter(element=>element.getClientRects().length>0).slice(0,8).map(renderedStructure)}};
}
