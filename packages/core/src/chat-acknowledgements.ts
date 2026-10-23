import type {ChatAcknowledgement,ConversationSnapshot} from '@jobpilot/contracts';
import {explicitRefusal} from '../../contracts/src/chat-rules.js';

// These texts acknowledge a human decision. They neither claim an attachment
// was sent nor authorize any platform consent button or file operation.
export const acknowledgementText:Record<ChatAcknowledgement,string>={
  'resume-consent':'您好，可以的。',
  'resume-decline':'您好，暂时先不提供附件简历，谢谢理解。',
};

export function resumeRequest(chat:ConversationSnapshot){
  if(!chat.identityBound||!chat.historyComplete||chat.messages.length>100)return null;
  if(chat.messages.some(message=>message.direction!=='outgoing'&&explicitRefusal(message.text)))return null;
  const latest=chat.messages.filter(message=>message.direction!=='system').at(-1);
  if(!latest?.confirmed||!latest.id||latest.direction!=='incoming')return null;
  if(!/简历/.test(latest.text)||!/想要|一份|附件|发|提供|是否.*同意/.test(latest.text))return null;
  if(/身份证|银行卡|转账|验证码|交费|付费|https?:|忽略.{0,8}(规则|指令)/i.test(latest.text))return null;
  return latest;
}
