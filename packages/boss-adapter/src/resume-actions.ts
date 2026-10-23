import {conversationRoot,visibleMessages} from './conversation.js';
import {renderedMessageId} from './rendered-metadata.js';
import {resumeRequestButtons,resumeSelection} from './resume-card.js';
import {explicitRefusal} from '../../contracts/src/chat-rules.js';
import type {ConversationSnapshot} from '@jobpilot/contracts';
type Input={operation:string;expectedInboundId?:string;intentId:string;deadline:number};
export function performResume(input:Input,chat:ConversationSnapshot|null){
 const fail=(code:string,message:string)=>({ok:false,code,message}),root=conversationRoot();
 if(!root||!chat?.identityBound||!chat.historyComplete||!input.expectedInboundId)return fail('CONVERSATION_CHANGED','附件发送需要已绑定且历史完整的目标会话。');
 const all=visibleMessages(root),messages=all.filter(message=>message.direction!=='system');
 const requestIndex=messages.findIndex(message=>message.id===input.expectedInboundId&&message.direction==='incoming'&&message.confirmed);
 if(requestIndex<0)return fail('CONVERSATION_CHANGED','未找到已确认的附件请求。');
 const before=()=>{try{return JSON.parse(root.dataset.jobpilotResumeBaseline??'[]') as string[];}catch{return [];}};
 const proof=messages.slice(requestIndex+1).filter(message=>message.direction==='outgoing'&&message.confirmed&&message.attachment?.delivered&&!before().includes(message.id)&&(!root.dataset.jobpilotResumeName||message.attachment.name===root.dataset.jobpilotResumeName));
 if(input.operation==='resume-verify'&&root.dataset.jobpilotResumeIntent===input.intentId&&proof.length===1)root.dataset.jobpilotResumeVerified=input.intentId;
 if(input.operation==='resume-verify')return {ok:true,data:root.dataset.jobpilotResumeIntent===input.intentId&&proof.length===1?{state:'CONFIRMED',messageId:proof[0].id,message:'目标会话新增附件简历已送达：'+proof[0].attachment!.name}:{state:'UNKNOWN',message:'未确认目标请求之后新增且送达的附件，禁止自动重发。'}};
 if(!Number.isFinite(input.deadline)||Date.now()>input.deadline)return fail('ACTION_EXPIRED','附件发送授权已过期。');
 if(all.some(message=>message.direction!=='outgoing'&&message.resumeRequest?.state!=='declined'&&explicitRefusal(message.text)))return fail('CONVERSATION_REJECTED','对方已拒绝，停止发送附件。');
 if(proof.length&&root.dataset.jobpilotResumeIntent===input.intentId)return {ok:true,data:{submitted:true,done:true}};
 const latest=messages.at(-1);if(latest?.id!==input.expectedInboundId)return fail('CONVERSATION_CHANGED','附件请求之后已有新消息，停止发送。');
 const nodes=[...root.querySelectorAll<HTMLElement>('.message-item,.chat-message-item,[data-message-id]')].filter(node=>node.getClientRects().length>0&&!node.parentElement?.closest('.message-item,.chat-message-item,[data-message-id]')&&(node.getAttribute('data-message-id')??node.getAttribute('data-mid')??renderedMessageId(node))===input.expectedInboundId);
 if(nodes.length!==1)return fail('ADAPTER_CHANGED','无法唯一定位附件请求卡片。');
 const buttons=resumeRequestButtons(nodes[0]),button=buttons.length===1?buttons[0]:null;
 if(input.operation==='resume-prepare'){
  if(latest.resumeRequest?.state!=='pending'||!button||button.matches(':disabled,[aria-disabled="true"],.disabled'))return fail('RESUME_REQUEST_HANDLED','附件请求已处理或没有可用的同意入口；不会补发文字。');
  return {ok:true,data:{prepared:true}};
 }
 if(input.operation==='resume-submit'){
  if(root.dataset.jobpilotResumeIntent&&root.dataset.jobpilotResumeVerified===root.dataset.jobpilotResumeIntent&&root.dataset.jobpilotResumeInbound!==input.expectedInboundId){for(const key of ['jobpilotResumeIntent','jobpilotResumeBaseline','jobpilotResumeName','jobpilotResumeDispatched','jobpilotResumeSelected','jobpilotResumeVerified','jobpilotResumeInbound'])delete root.dataset[key];}
  if(root.dataset.jobpilotResumeIntent||latest.resumeRequest?.state!=='pending'||!button||button.matches(':disabled,[aria-disabled="true"],.disabled'))return fail('DUPLICATE_SEND','此附件请求已提交或不可用，不能重复同意。');
  root.dataset.jobpilotResumeIntent=input.intentId;root.dataset.jobpilotResumeInbound=input.expectedInboundId;root.dataset.jobpilotResumeBaseline=JSON.stringify(messages.map(message=>message.id));
  button.dataset.jobpilotSubmitted=input.intentId;button.click();return {ok:true,data:{submitted:true,done:false}};
 }
 if(input.operation!=='resume-dialog-send'||(root.dataset.jobpilotResumeIntent!==input.intentId||root.dataset.jobpilotResumeInbound!==input.expectedInboundId))return fail('CONSENT_REQUIRED','缺少本次附件发送意图。');
 if(root.dataset.jobpilotResumeDispatched)return {ok:true,data:{submitted:true,done:true}};
 let selection:ReturnType<typeof resumeSelection>;try{selection=resumeSelection();}catch{return fail('ADAPTER_CHANGED','附件选择窗口不唯一，请人工核对。');}
 if(!selection)return {ok:true,data:{submitted:true,done:false}};
 const {item,name,selected,button:send}=selection;
 if(!item||!name||name.length>200||!send)return fail('RESUME_SELECTION_REQUIRED','未找到唯一附件或明确选中的默认版本，请在 BOSS 人工处理；不猜选第一个文件。');
 if(root.dataset.jobpilotResumeName&&root.dataset.jobpilotResumeName!==name)return fail('DRAFT_CHANGED','附件选择已变化，停止发送。');
 root.dataset.jobpilotResumeName=name;
 if(!selected){if(root.dataset.jobpilotResumeSelected)return fail('ADAPTER_CHANGED','未确认附件选择生效。');root.dataset.jobpilotResumeSelected='true';item.click();return {ok:true,data:{submitted:true,done:false}};}
 if(send.matches(':disabled,[aria-disabled="true"],.disabled,.disable'))return fail('ADAPTER_CHANGED','附件发送按钮不可用。');
 root.dataset.jobpilotResumeDispatched=input.intentId;send.click();return {ok:true,data:{submitted:true,done:true}};
}
