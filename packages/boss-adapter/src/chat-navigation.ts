import {conversationSnapshot,conversationRoot} from './conversation.js';

const visible=(node:Element)=>node.getClientRects().length>0;
export function conversationTargets(){
  const rows=[...document.querySelectorAll<HTMLElement>('.chat-user .friend-content[data-boss-id],.user-list [data-boss-id],.chat-user-list [data-boss-id],.contact-list [data-boss-id]')].filter(visible);
  const targets=rows.flatMap(node=>{
    const recruiterId=node.getAttribute('data-boss-id')??'',name=node.getAttribute('data-jobpilot-chat-target-name')??'';
    if(!/^[A-Za-z0-9_~=-]{3,200}$/.test(recruiterId)||!name||node.querySelector('.name-text')?.textContent?.trim()!==name)return [];
    return [{recruiterId,name:name.slice(0,80),company:node.querySelector('.company-name')?.textContent?.trim().slice(0,120)??''}];
  });
  return targets.filter(target=>targets.filter(other=>other.recruiterId===target.recruiterId).length===1).slice(0,100);
}
// Scroll only rendered chat containers. No input, network or message submission.
export function scrollChat(kind:'history'|'contacts',recruiterId:string,reset=false){
  if(location.pathname!=='/web/geek/chat')return {ok:false,code:'CHAT_PAGE_REQUIRED',message:'请打开并连接 BOSS 消息页。'};
  if(kind==='history'){
    const chat=conversationSnapshot();if(!chat?.identityBound||chat.recruiterId!==recruiterId)return {ok:false,code:'TARGET_MISMATCH',message:'加载历史时会话已变化。'};
    const root=conversationRoot(),record=root?.querySelector<HTMLElement>('.chat-record,.chat-message-list');
    if(!record)return {ok:false,code:'ADAPTER_CHANGED',message:'未识别聊天历史容器。'};
    record.scrollTop=0;record.dispatchEvent(new Event('scroll',{bubbles:true}));return {ok:true,data:{scrolled:true}};
  }
  const containers=[...document.querySelectorAll<HTMLElement>('.chat-user .user-list,.chat-user .chat-content,.chat-user-list,.contact-list')].filter(node=>visible(node)&&node.scrollHeight>node.clientHeight);
  const root=containers.find(node=>!containers.some(other=>other!==node&&node.contains(other)));
  if(!root)return {ok:true,data:{scrolled:false}};
  const previous=root.scrollTop;root.scrollTop=reset?0:previous+Math.max(300,root.clientHeight*0.8);root.dispatchEvent(new Event('scroll',{bubbles:true}));return {ok:true,data:{scrolled:previous!==root.scrollTop}};
}
