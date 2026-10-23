import type {ConversationSnapshot} from '@jobpilot/contracts';
import {AppError} from '@jobpilot/contracts';
export function bindConversation(current:ConversationSnapshot,target:ConversationSnapshot){
 const wanted=new Set([target.recruiterId,...target.recruiterAliases??[]]);
 if(!current.identityBound||current.name.trim()!==target.name.trim()||![current.recruiterId,...current.recruiterAliases??[]].some(id=>wanted.has(id))||(current.jobId&&target.jobId&&current.jobId!==target.jobId))throw new AppError('TARGET_MISMATCH','会话切换后姓名、招聘人标识或岗位不符，已停止。');
 return {...current,id:target.id,recruiterId:target.recruiterId,recruiterAliases:[...new Set([...wanted,current.recruiterId,...current.recruiterAliases??[]])]};
}
export function requireChatConnection(page:{url?:string|null;readerConnected?:boolean;conversation?:ConversationSnapshot},switching=false){
 if(page.url!=='https://www.zhipin.com/web/geek/chat')throw new AppError('CHAT_PAGE_REQUIRED','请先打开 BOSS 消息页并选择联系人。');
 if(!page.readerConnected&&(switching||!page.conversation?.identityBound))throw new AppError('CHAT_READER_REQUIRED','当前消息页的只读连接未启用或刷新后失效。请点击 Chrome 扩展“连接当前页面（只读）”；可在新版扩展中开启“记住只读连接”，避免重启后重复操作。');
}
