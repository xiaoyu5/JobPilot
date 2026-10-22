import React,{useState} from 'react';
import type {FactCategoryName} from '@jobpilot/contracts';

export function ManualFactForm({version,disabled,onAdd}:{version:number;disabled:boolean;onAdd:(input:{expectedVersion:number;text:string;category:FactCategoryName})=>Promise<void>}){
  const [text,setText]=useState(''),[category,setCategory]=useState<FactCategoryName>('skill');
  return <details className="panel"><summary>补充一条真实事实</summary><p>补充原简历没有写明的能力或经历。新增条目会标为待审核，确认后再冻结；不改变原有工作和项目记录。</p><form onSubmit={event=>{event.preventDefault();void onAdd({expectedVersion:version,text,category}).then(()=>setText('')).catch(()=>{});}}><label>事实内容<textarea aria-label="补充事实内容" rows={3} required minLength={5} maxLength={2000} value={text} onChange={e=>setText(e.target.value)} disabled={disabled}/></label><label>事实类别<select aria-label="补充事实类别" value={category} onChange={e=>setCategory(e.target.value as FactCategoryName)} disabled={disabled}>{[['skill','技能'],['experience','工作经历'],['project','项目经历'],['education','教育'],['other','其他']].map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><button disabled={disabled||text.trim().length<5}>添加待审核事实</button></form></details>;
}
