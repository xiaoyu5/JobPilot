import {advanceSearchPage} from './search-navigation.js';
import {scrollChat} from './chat-navigation.js';
import {snapshot} from './snapshot.js';
import {communicationIdentity,communicationInfo,composer,contactEntries} from './communication.js';
import {conversationSnapshot,conversationRefused} from './conversation.js';
import {performResume} from './resume-actions.js';
type Input={operation:'prepare'|'submit'|'verify'|'contact-submit'|'contact-verify'|'chat-open'|'chat-history'|'chat-contacts'|'search-next'|'chat-continue'|'resume-prepare'|'resume-submit'|'resume-dialog-send'|'resume-verify';reset?:boolean;jobId:string;recruiterId:string;content:string;intentId:string;deadline:number;purpose?:'default-then-ai'|'first-contact-ai'|'reply';initialMessageId?:string;expectedInboundId?:string};
export function perform(value:unknown){
  const input=value as Input,fail=(code:string,message:string)=>({ok:false,code,message});
  if(!input||!['prepare','submit','verify','contact-submit','contact-verify','chat-open','chat-history','chat-contacts','search-next','chat-continue','resume-prepare','resume-submit','resume-dialog-send','resume-verify'].includes(input.operation)||!input.recruiterId||(!input.jobId&&input.purpose!=='reply')||typeof input.content!=='string'||input.content.length>1000)return fail('INVALID_SEND_INPUT','发送上下文无效。');
  const page=snapshot();if(page.state!=='LOGGED_IN')return fail(page.state==='CHALLENGE'?'BOSS_CHALLENGE':page.state==='LOGIN_REQUIRED'?'BOSS_LOGIN_REQUIRED':'ADAPTER_CHANGED','页面未处于正常登录状态。');
  if(input.operation==='search-next'){if(!Number.isFinite(input.deadline)||Date.now()>input.deadline)return fail('ACTION_EXPIRED','读取动作已过期。');return advanceSearchPage();}
  if(input.operation==='chat-history'||input.operation==='chat-contacts'){if(!Number.isFinite(input.deadline)||Date.now()>input.deadline)return fail('ACTION_EXPIRED','读取动作已过期。');return scrollChat(input.operation==='chat-history'?'history':'contacts',input.recruiterId,input.reset);}
  if(input.operation==='chat-open'){
    if(!Number.isFinite(input.deadline)||Date.now()>input.deadline)return fail('ACTION_EXPIRED','读取动作已过期。');
    const entries=[...document.querySelectorAll<HTMLElement>('.chat-user .friend-content[data-boss-id],.user-list [data-boss-id],.user-list [data-bossid],.chat-user-list [data-boss-id],.contact-list [data-boss-id]')].filter(node=>node.getClientRects().length>0&&(node.getAttribute('data-boss-id')??node.getAttribute('data-bossid'))===input.recruiterId);
    if(entries.length!==1)return fail('CHAT_NOT_VISIBLE','无法在可见联系人列表中唯一定位所选会话，请先手动打开该会话并连接只读扩展。');
    const name=entries[0].getAttribute('data-jobpilot-chat-target-name');if(name&&entries[0].querySelector('.name-text')?.textContent?.trim()!==name)return fail('CHAT_NOT_VISIBLE','联系人列表已变化，请重新读取会话。');
    entries[0].click();return {ok:true,data:{opened:true}};
  }
  const identity=communicationIdentity();
  const chat=conversationSnapshot(),messages=chat?.messages.filter(message=>message.direction!=='system')??[];
  if((input.jobId&&(identity.jobIds.length!==1||identity.jobIds[0]!==input.jobId))||identity.recruiterIds.length!==1||(identity.recruiterIds[0]!==input.recruiterId&&!chat?.recruiterAliases?.includes(input.recruiterId)))return fail('TARGET_MISMATCH','当前岗位或招聘人与已确认目标不一致。');
  if(input.operation.startsWith('resume-'))return performResume(input,chat);
  if(input.operation==='chat-continue'){
    if(!Number.isFinite(input.deadline)||Date.now()>input.deadline)return fail('ACTION_EXPIRED','导航动作已过期。');
    const entries=contactEntries();if(entries.length!==1||entries[0].textContent?.trim()!=='继续沟通'||entries[0].matches(':disabled,[aria-disabled="true"],.disabled'))return fail('ALREADY_CONTACTED','仅允许点击明确的继续沟通入口，绝不点击立即沟通。');
    entries[0].click();return {ok:true,data:{opened:true}};
  }
  if(input.operation==='verify'||input.operation==='contact-verify'){
    // Legacy greeting modal fixtures also expose messages within the job scope.
    const roots=chat?[]:[...document.querySelectorAll<HTMLElement>('.message-item.is-self,.message-item.sent,.message-item.mine,.chat-message.is-self')];
    const outgoing=[...messages.filter(message=>message.direction==='outgoing'),...roots.filter(node=>node.getClientRects().length>0&&node.closest('.job-detail,.greet-dialog,.greeting-dialog')&&!node.closest('.user-list,.more-job-section')).map(node=>({id:node.getAttribute('data-message-id')??'',text:node.querySelector('.text,.message-text,.text-content')?.textContent?.trim()??'',confirmed:!node.matches('.sending,.pending,.failed,.error')&&!node.querySelector('.sending,.pending,.failed,.error')}))].filter(message=>message.id&&!/^(local|temp|pending)/i.test(message.id)&&message.confirmed);
    const inboundIndex=messages.findIndex(message=>message.direction==='incoming'&&message.id===input.expectedInboundId);
    const eligible=input.purpose==='reply'?(inboundIndex<0?[]:outgoing.filter(message=>messages.findIndex(item=>item.id===message.id)>inboundIndex)):outgoing;
    const matches=eligible.filter(message=>message.text===input.content.trim());
    const proof=input.operation==='contact-verify'?(outgoing.length===1&&!messages.some(message=>message.direction==='incoming')&&outgoing[0].text.trim()&&!/\.(pdf|docx?)$/i.test(outgoing[0].text.trim())?outgoing[0]:undefined):(matches.length===1?matches[0]:undefined);
    if(proof){const field=composer()?.input;if(field?.dataset.jobpilotIntent&&field.dataset.jobpilotSubmitted===field.dataset.jobpilotIntent)field.dataset.jobpilotVerified=field.dataset.jobpilotIntent;}
    return {ok:true,data:proof?{state:'CONFIRMED',messageId:proof.id,message:'目标会话可见消息已确认。'}:{state:'UNKNOWN',message:'未找到可靠对应消息，请人工核验；不会自动重发。'}};
  }
  if(!Number.isFinite(input.deadline)||Date.now()>input.deadline)return fail('ACTION_EXPIRED','动作授权已过期。');
  if(conversationRefused())return fail('CONVERSATION_REJECTED','该会话存在明确拒绝或结束信号，停止联系。');
  if(input.operation==='contact-submit'){
    if(input.purpose!=='default-then-ai')return fail('CONSENT_REQUIRED','未确认平台默认招呼加 AI 文案的两条消息流程。');
    const entries=contactEntries();if(entries.length!==1||entries[0].textContent?.trim()!=='立即沟通'||communicationInfo().alreadyContacted)return fail('ALREADY_CONTACTED','只能对尚未沟通过的唯一入口执行首次联系。');
    const button=entries[0];if(button.dataset.jobpilotSubmitted||button.matches(':disabled,[aria-disabled="true"],.disabled'))return fail('DUPLICATE_SEND','入口已提交或不可用。');
    button.dataset.jobpilotSubmitted=input.intentId;button.click();return {ok:true,data:{submitted:true}};
  }
  if(input.purpose==='reply'){
    const latest=messages.at(-1);if(!chat?.identityBound||!chat.historyComplete||!input.expectedInboundId||latest?.direction!=='incoming'||latest.id!==input.expectedInboundId)return fail('CONVERSATION_CHANGED','对方最新消息或历史完整性已变化，不能自动回复。');
  }else if(input.purpose==='first-contact-ai'){
    const latest=messages.at(-1);if(!input.initialMessageId||latest?.direction!=='outgoing'||latest.id!==input.initialMessageId)return fail('CONVERSATION_CHANGED','默认招呼后会话已变化，停止追加消息。');
  }else if(communicationInfo().alreadyContacted)return fail('ALREADY_CONTACTED','已有会话不能再次走首联流程。');
  let editor=composer();
  if(!editor&&input.operation==='prepare'){
    const entries=[...document.querySelectorAll<HTMLElement>('button[aria-controls],a[role="button"][aria-controls]')].filter(node=>node.getClientRects().length>0&&/^(编辑招呼语|填写招呼语|写招呼语)$/.test(node.textContent?.trim()??'')&&!!document.getElementById(node.getAttribute('aria-controls')??''));
    if(entries.length!==1)return fail('ADAPTER_CHANGED','未识别到可编辑入口，未点击立即沟通。');entries[0].click();editor=composer();if(!editor)return {ok:true,data:{prepared:false,opening:true}};
  }
  if(!editor)return fail('ADAPTER_CHANGED','未找到唯一可见的编辑框及明确发送方式。');
  const {input:field,button,sendBy}=editor;
  if(input.operation==='prepare'){
    if(field.dataset.jobpilotIntent&&field.dataset.jobpilotIntent!==input.intentId){if(field.dataset.jobpilotVerified!==field.dataset.jobpilotIntent)return fail('TARGET_MISMATCH','编辑框由未核验的旧意图持有，请先人工核对。');delete field.dataset.jobpilotIntent;delete field.dataset.jobpilotSubmitted;delete field.dataset.jobpilotVerified;}
    const old=field instanceof HTMLTextAreaElement?field.value:field.textContent??'';
    if(old.trim()&&old.trim()!==input.content.trim())return fail('COMPOSER_NOT_EMPTY','编辑框已有其它内容，请先人工检查。');
    if(field.dataset.jobpilotIntent!==input.intentId||old!==input.content){
      field.focus();if(field instanceof HTMLTextAreaElement){const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;if(!setter)return fail('ADAPTER_CHANGED','不支持此编辑框。');setter.call(field,input.content);}else field.textContent=input.content;
      field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));field.dataset.jobpilotIntent=input.intentId;
    }
    // Framework state can enable Send asynchronously. Poll without rewriting
    // the editor, and do not advance the durable intent to click-dispatched yet.
    const ready=!button?.matches(':disabled,[aria-disabled="true"],.disabled,.disable');
    return {ok:true,data:{prepared:ready,waitingForEditor:!ready}};
  }
  const actual=field instanceof HTMLTextAreaElement?field.value:field.textContent??'';
  if(field.dataset.jobpilotIntent!==input.intentId||actual!==input.content||field.dataset.jobpilotSubmitted)return fail('DRAFT_CHANGED','文案或提交状态已变化。');
  if(button?.matches(':disabled,[aria-disabled="true"],.disabled,.disable'))return fail('ADAPTER_CHANGED','发送按钮不可用。');
  if(Date.now()>input.deadline)return fail('ACTION_EXPIRED','动作授权已过期。');
  field.dataset.jobpilotSubmitted=input.intentId;
  if(sendBy==='button')button!.click();else field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
  return {ok:true,data:{submitted:true}};
}
