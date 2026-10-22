// Shared, deterministic rules. Only messages from the selected conversation are examined.
export function explicitRefusal(text:string){
  if(/\b(?:not a (?:good )?fit|position.{0,12}filled|no longer hiring|please stop)\b/i.test(text))return true;
  const value=text.replace(/\s+/g,'');
  // A polite closing can reject without using “不合适”. Require both an
  // experience mismatch and a job-search farewell, rather than treating a
  // question about different experience as rejection.
  if(/(?:经验|经历|背景|条件|技能).{0,12}不(?:完全)?(?:一致|符合|匹配)/.test(value)&&/祝.{0,25}(?:找到|求职).{0,15}(?:工作|顺利|成功)/.test(value))return true;
  if(/岗位.{0,12}(招满|关闭|暂停|取消)|不再招聘|请勿.{0,6}(联系|打扰)|不用再.{0,6}(联系|发)|no longer hiring|please stop/i.test(value))return true;
  if(/不是不合适|没有不合适|并非不合适|不是拒绝|不会拒绝|不要拒绝|如果.{0,12}(不考虑|不合适)/.test(value))return false;
  return /对方.{0,8}(已)?拒绝|很遗憾|不太?合适|不太?匹配|(?:暂(?:时)?|目前|现在)不(?:予)?考虑|不符合.{0,12}(要求|需求)|岗位.{0,12}(招满|关闭|暂停|取消)|已经?招到|不再招聘|(?:只|仅)(?:考虑|招聘)|目前没有.{0,8}(岗位|职位)|没有.{0,8}(合适|匹配).{0,8}(岗位|职位)|not a (?:good )?fit|position.{0,8}filled|no longer hiring|please stop|暂无.{0,8}(招聘|用人)需求|祝.{0,12}(早日|顺利).{0,8}(找到|求职)|不用再.{0,6}(联系|发)|请勿.{0,6}(联系|打扰)|不需要.{0,6}(联系|沟通)/i.test(value);
}
export function needsHumanReply(text:string){return /意向|考虑|接受|拒绝|薪资|薪酬|工资|期望|待遇|到岗|离职|面试|几点|周[一二三四五六日天]|明天|今天|电话|微信|手机号|邮箱|简历|附件|身份证|银行卡|转账|验证码|链接|https?:|忽略.{0,8}(指令|规则)|system\s*prompt/i.test(text);}
export function isReplyQuestion(text:string){return /^(您好|你好|hello|hi)[!！。\s]*$|[?？]|能否|方便|介绍|了解|经验|做过|熟悉|什么|多少|请问|是否|聊聊|看看/.test(text)&&!/^\s*(收到|好的|谢谢|嗯|ok)[!！。\s]*$/i.test(text);}
