import {businessId} from './business-id.js';
const visible=(node:Element)=>node.getClientRects().length>0;
export function startChatRoot(){const roots=[...document.querySelectorAll<HTMLElement>('.startchat-dialog')].filter(visible);return roots.length===1?roots[0]:null;}
export function startChatIdentity(root:Element){
  const jobId=location.pathname.match(/^\/job_detail\/([A-Za-z0-9_-]+)\.html$/)?.[1],entries=[...document.querySelectorAll<HTMLElement>('.job-banner .btn-startchat')].filter(visible);
  const name=document.querySelector('.job-boss-info .name')?.textContent?.replace(/\s+/g,'')??'',header=root.querySelector('.startchat-title')?.textContent?.replace(/\s+/g,'')??'';
  if(!jobId||entries.length!==1||!name||!header.startsWith(name))return null;
  try{const link=new URL(entries[0].getAttribute('redirect-url')??'',location.origin),recruiterId=businessId(link.searchParams.get('id')??link.searchParams.get('bossId'));
    if(link.origin!==location.origin||link.pathname!=='/web/geek/chat'||link.searchParams.get('jobId')!==jobId||!recruiterId)return null;
    return {jobId,recruiterId,name};
  }catch{return null;}
}
// A visible platform receipt is evidence, never presented as a server message ID.
// Two independent hashes identify this exact text/position/target between DOM reads.
function receiptId(value:string){let a=2166136261,b=5381;for(const c of value){a=Math.imul(a^c.charCodeAt(0),16777619);b=Math.imul(b,33)^c.charCodeAt(0);}return 'visible-receipt:'+ (a>>>0).toString(16)+(b>>>0).toString(16);}
export function startChatMessages(root:Element){const identity=startChatIdentity(root);
  return [...root.querySelectorAll<HTMLElement>('.message-list > .message-item')].filter(visible).slice(-100).map((node,index)=>{
    const body=node.querySelector('.text,.message-text,.text-content'),text=body?.textContent?.trim()??'';
    const receipts=[...node.querySelectorAll('.status,.message-status')].filter(element=>visible(element)&&!body?.contains(element));
    const sent=receipts.length===1&&receipts[0].textContent?.trim()==='已发送'&&!node.matches('.sending,.pending,.failed,.error');
    const id=identity&&sent&&text?receiptId(JSON.stringify([identity.jobId,identity.recruiterId,index,text])):'';
    return {id,direction:sent?'outgoing' as const:'incoming' as const,text:text.slice(0,4000),confirmed:!!id};
  });
}
export function startChatDiagnostics(){const root=startChatRoot();if(!root)return null;
  return {identityBound:!!startChatIdentity(root),elements:[root,...root.querySelectorAll('*')].slice(0,100).map(node=>({tag:node.tagName,className:node.className,attributes:[...node.attributes].filter(attr=>!['class','style','src','href'].includes(attr.name)).map(attr=>({name:attr.name,length:attr.value.length})),receipt:node.children.length===0&&node.textContent?.trim()==='已发送'}))};
}
