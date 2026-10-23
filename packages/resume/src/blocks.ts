import {redact,type PendingFact,type FactCategoryName} from '@jobpilot/contracts';

export type ResumeBlock={text:string;heading?:number;ignore?:boolean};
const clean=(text:string)=>text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();
function htmlText(value:string){
  return clean(value.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(entity,key:string)=>{
    if(key[0]==='#'){const n=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}
    return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '} as Record<string,string>)[key.toLowerCase()]??entity;
  }));
}
// Mammoth produces escaped HTML; no browser, active content or external resources are loaded.
export function docxBlocks(html:string):ResumeBlock[]{
  return [...html.matchAll(/<(h[1-6]|p|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi)].map(match=>({text:htmlText(match[3]),...(/^h/.test(match[1])?{heading:Number(match[1][1])}:{}),ignore:/class="resume-(?:title|subtitle)"/.test(match[2])}));
}
export function extractFacts(pages:ResumeBlock[][],file:string,kind:'docx'|'pdf'){
  const facts:PendingFact[]=[],warnings:string[]=[];let category:FactCategoryName='other',project='',context='',skippedContacts=0,strongClaims=0;
  const add=(text:string,quote:string,paragraph:number,page:number,field:FactCategoryName=category)=>{
    for(let offset=0;offset<text.length;offset+=1500){const chunk=text.slice(offset,offset+1500);facts.push({text:chunk,category:field,source:{file,kind,...(kind==='pdf'?{page}:{}),paragraph,quote:redact(quote).slice(0,4000)}});}
  };
  pages.forEach((blocks,pageIndex)=>blocks.forEach((block,index)=>{
    const paragraph=clean(block.text);if(!paragraph||block.ignore)return;
    const section=paragraph.replace(/[:：]\s*$/,'');
    if(/^(个人优势|专业概述|职业概述|个人简介|专业技能|技术栈|技能|skills?)$/i.test(section)){category='skill';project='';context='';return;}
    if(/^(工作经历|工作经验|职业经历|experience)$/i.test(section)){category='experience';project='';context='';return;}
    if(/^(项目经历|项目经验|开源项目|个人项目|projects?)$/i.test(section)){category='project';project='';context='';return;}
    if(/^(教育经历|教育背景|学历|education)$/i.test(section)){category='education';project='';context='';return;}
    if(/^(电话|手机|邮箱|email|联系方式|姓名)[:：]/i.test(paragraph)||/\b1[3-9]\d{9}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(paragraph)){skippedContacts++;return;}
    if(category==='project'&&block.heading){project=section==='早期项目'?'':paragraph;context='';return;}
    if(paragraph.length<5||/^(?:个人)?简历$|简历$/u.test(paragraph)&&paragraph.length<20)return;
    let text=redact(paragraph);
    // A profile/portfolio link is not an experience claim or an approved greeting.
    if(/^(?:GitHub[:：]\s*)?(?:https?:\/\/|github\.com\/)/i.test(text)){
      const parts=text.split(/[|｜]/).slice(1).map(s=>s.trim()).filter(Boolean);if(!parts.length){skippedContacts++;return;}text=parts.join(' | ');
    }
    if(category==='other'&&/[|｜]/.test(text)&&/本科|硕士|博士|大专|学士/.test(text)){
      const parts=text.split(/[|｜]/).map(s=>s.trim()),education=parts.filter(s=>/本科|硕士|博士|大专|学士|专业|计算机科学|软件工程/.test(s)&&!/开发经验|求职意向/.test(s));
      if(education.length)add(education.join(' | '),paragraph,index+1,pageIndex+1,'education');
      for(const part of parts.filter(s=>/\d+\s*年.*(?:经验|开发)/.test(s)))add(part,paragraph,index+1,pageIndex+1,'experience');
      if(education.length)return;
    }
    if(/敏感数据不出本机|保证录用|精通所有|零(?:风险|故障|事故)/.test(text))strongClaims++;
    if(project){
      if(/[|｜]/.test(text)&&!/[。！？]/.test(text))context=paragraph;
      add(`${project}：${text}`,[project,...(context&&context!==paragraph?[context]:[]),paragraph].join('\n'),index+1,pageIndex+1);
    }else add(text,paragraph,index+1,pageIndex+1);
  }));
  if(skippedContacts)warnings.push(`已跳过 ${skippedContacts} 段联系方式或纯链接，不作为能力事实。`);
  if(strongClaims)warnings.push(`发现 ${strongClaims} 条绝对化或数据边界表述，请结合实际实现重点核对。`);
  return {facts,warnings};
}
