import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Store} from '@jobpilot/store';
import {parseResumeFile} from '@jobpilot/resume';
import {ResumeImport,type PendingFact} from '@jobpilot/contracts';
import {structuredResumeFixture} from './resume-fixtures.js';

test('styled DOCX imports scoped claims, excludes contacts/headings, and retains complete qualifications and source context',async()=>{
  const dir=await mkdtemp('/tmp/jp-structured-resume-');try{
    const parsed=await parseResumeFile(await structuredResumeFixture(dir));
    assert(parsed.facts.some(f=>f.category==='skill'&&f.text.includes('独立完成')));assert(parsed.facts.some(f=>f.category==='education'&&f.text==='本科 | 计算机科学与技术'));assert(parsed.facts.some(f=>f.category==='experience'&&f.text==='10 年 iOS 开发经验'));
    assert(!JSON.stringify(parsed.facts).includes('13800138000'));assert(!JSON.stringify(parsed.facts).includes('anonymous@example.com'));assert(!parsed.facts.some(f=>/\[PHONE\]|\[EMAIL\]|github\.com/.test(f.text)));
    assert(!parsed.facts.some(f=>['匿名地图项目','匿名桌面工具','个人优势','开源项目'].includes(f.text)));
    const limited=parsed.facts.find(f=>f.text.includes('未独立实现'))!;assert.equal(limited.text,'匿名地图项目：仅集成 P2P SDK，未独立实现协议栈或内核。');assert(limited.source.quote.includes('匿名设备公司'));assert(limited.source.quote.includes('未独立实现'));assert.equal(limited.source.paragraph,14);
    assert(parsed.facts.some(f=>f.text==='匿名桌面工具：Tauri、TypeScript'));assert(parsed.warnings.some(w=>w.includes('数据边界')));
    assert(parsed.facts.every(f=>f.source.kind==='docx'&&f.source.file==='anonymous-resume.docx'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
const fact=(text:string,kind:'docx'|'pdf'|'text'='docx'):PendingFact=>({text,category:'project',source:{file:'anonymous.docx',kind,paragraph:1,quote:text}});
test('explicit resume replacement archives imported facts, retains manual approvals and frozen history, and never approves new facts',async()=>{
  const dir=await mkdtemp('/tmp/jp-resume-replace-'),store=new Store(dir);try{
    store.importFacts('old.docx','old',[fact('旧版匿名项目事实。'),fact('旧版教育经历事实。','pdf')]);
    for(const f of store.resume().facts)store.updateFact({id:f.id,expectedVersion:f.version,approved:true});store.freezeResume(store.resume().version);
    store.addFact({expectedVersion:store.resume().version,text:'用户确认能够独立交付 App 并上线。',category:'experience'});const manual=store.resume().facts.at(-1)!;store.updateFact({id:manual.id,expectedVersion:manual.version,approved:true});store.freezeResume(store.resume().version);
    const before=store.resume(),snapshot=store.db.prepare('SELECT facts_json FROM resume_snapshots WHERE version=?').get(before.version)!.facts_json,kept=before.facts.find(f=>f.id===manual.id)!;
    assert.throws(()=>ResumeImport.parse({path:'/tmp/a.docx',mode:'replace-imported'}));
    assert.throws(()=>store.importFacts('new.docx','new',[fact('新版匿名项目事实。')],{mode:'replace-imported',expectedVersion:before.version-1}),{code:'VERSION_CONFLICT'});assert.equal(store.resume().version,before.version);
    const result=store.importFacts('new.docx','new',[fact('新版匿名项目事实。'),fact('新版匿名项目事实。')],{mode:'replace-imported',expectedVersion:before.version});
    assert.deepEqual(result.importSummary,{added:1,duplicates:1,archived:2,retained:1});assert.equal(result.facts.length,2);assert.equal(result.approvedCount,1);assert.equal(result.frozenVersion,null);assert.deepEqual(result.facts.find(f=>f.id===manual.id),kept);assert.equal(result.facts.find(f=>f.text==='新版匿名项目事实。')!.approved,false);
    assert.equal(store.db.prepare('SELECT count(*) n FROM resume_facts WHERE deleted=1').get()!.n,2);assert.equal(store.db.prepare('SELECT facts_json FROM resume_snapshots WHERE version=?').get(before.version)!.facts_json,snapshot);
    const merged=store.importFacts('another.docx','different',[fact('新版匿名项目事实。'),fact('另一个新版匿名项目事实。')]);assert.equal(merged.importSummary?.duplicates,1);assert.equal(merged.importSummary?.added,1);assert.equal(merged.approvedCount,1);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
