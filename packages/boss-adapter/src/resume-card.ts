// Only visible controls and attachment receipts in the currently bound conversation.
const visible=(node:Element)=>node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden';
const label=(node:Element)=>node.textContent?.trim()??'';
export function resumeRequestButtons(node:Element){
  if(!/附件简历/.test(node.textContent??'')||!/想要|索取|请求|是否同意/.test(node.textContent??''))return [];
  const candidates=[...node.querySelectorAll<HTMLElement>('button,a,[role="button"],.btn,[class*="btn"],[class*="action"]')].filter(item=>visible(item)&&/^(同意|同意并发送|同意并发送简历)$/.test(label(item)));
  return candidates.filter(item=>!candidates.some(other=>other!==item&&item.contains(other)));
}
export function resumeMessageMetadata(node:Element){
  const text=node.textContent??'',buttons=resumeRequestButtons(node);
  const request=/附件简历/.test(text)&&/想要|索取|请求|是否同意/.test(text);
  const state=request?(buttons.length===1?'pending':/已同意|已发送(?:附件)?简历|附件简历已发送/.test(text)?'accepted':/您已拒绝|已拒绝请求|已拒绝/.test(text)?'declined':undefined):undefined;
  const names=[...node.querySelectorAll('.resume-name,.file-name,.file-title,.message-file-name,.message-card-top-title')].filter(visible).map(label).filter(value=>/^[^\r\n]{1,180}\.(pdf|docx?)$/i.test(value));
  const name=[...new Set(names)];
  const card=node.querySelector('.message-card,.message-card-wrap,.resume-card,.file-card,[class*="resume"],[class*="attachment"]');
  const receipt=[...node.querySelectorAll('.message-status,.message-tip-bar,.status-read,.status-delivery')].filter(visible).some(item=>item.matches('.status-read,.status-delivery')||!!item.querySelector('.status-read,.status-delivery')||/送达|已发送|发送成功|已读/.test(label(item)));
  return {...(state?{resumeRequest:{state:state as 'pending'|'accepted'|'declined'}}:{}),...(!request&&card&&name.length===1?{attachment:{name:name[0],delivered:receipt}}:{})};
}
export function resumeSelection(){
  const dialogs=[...document.querySelectorAll<HTMLElement>('.choose-resume-dialog')].filter(visible);
  if(!dialogs.length)return null;
  if(dialogs.length!==1)throw new Error('无法唯一确认附件简历选择窗口。');
  const dialog=dialogs[0],items=[...dialog.querySelectorAll<HTMLElement>('.list-item')].filter(visible);
  const selected=items.filter(item=>item.matches('.selected,.active,.checked,[aria-selected="true"]')||!!item.querySelector('.selected,.active,.checked,[aria-checked="true"],input:checked'));
  const item=items.length===1?items[0]:selected.length===1?selected[0]:null;
  const name=item?.querySelector('.resume-name')?.textContent?.trim()??'';
  const buttons=[...dialog.querySelectorAll<HTMLElement>('.btn-confirm')].filter(node=>visible(node)&&/^(发送|发送简历|确认发送)$/.test(label(node)));
  return {dialog,item,name,selected:!!item&&selected.includes(item),button:buttons.length===1?buttons[0]:null};
}
