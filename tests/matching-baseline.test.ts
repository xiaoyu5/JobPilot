import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {calibrateAppGaps,hasAppDeliveryBaseline,MatchingService} from '@jobpilot/core';
import {FactAdd,type ResumeFact} from '@jobpilot/contracts';
import {Application} from '../packages/worker/src/application.js';
import {Store} from '@jobpilot/store';
import {withModel,goodResponse,prepare} from './m2-fixtures.js';

const baseline='具备多年App开发经验，能够独立完成App开发并发布上线。';
const fact=(text=baseline,approved=true):ResumeFact=>({id:randomUUID(),text,approved,category:'experience',version:1,updatedAt:new Date().toISOString(),source:{file:'匿名用户补充',kind:'text',paragraph:1,quote:text}});
const gap=(requirement:string)=>({requirement,severity:'hard' as const,reason:'需要进一步核对事实。'});

test('ordinary workflow gaps become interview checks only with confirmed app delivery evidence',()=>{
  assert(hasAppDeliveryBaseline([fact()]));assert(!hasAppDeliveryBaseline([fact(baseline,false)]));
  assert(!hasAppDeliveryBaseline([fact('有多年App开发经验。')]));assert(!hasAppDeliveryBaseline([fact('尚未独立完成App开发并发布上线。')]));
  const gaps=[gap('独立承担业务需求分析'),gap('根据需求文档、设计文档编写开发文档并完成自测')];
  for(const facts of [[],[fact(baseline,false)],[fact('有多年App开发经验。')]])assert.equal(calibrateAppGaps(gaps,facts).adjusted,0);
  const result=calibrateAppGaps(gaps,[fact()]);assert.equal(result.adjusted,2);assert(result.gaps.every(x=>x.severity==='soft'));
  assert.equal(gaps[0].severity,'hard','do not mutate raw model results');
});

test('general app experience cannot erase specialist, tenure, qualification or explicit conflicting evidence',()=>{
  const gaps=['需求分析并独立研发P2P协议栈','完成开发文档与内核驱动研发','需求分析及服务端架构研发','需求分析与Flutter整体架构建设','需求分析及三年Android商业经验','开发文档与CI/CD流水线建设','自测与自动化测试平台建设','需求分析及统招硕士学历','需求分析及英语口语沟通','需求分析并带领团队五人'].map(gap);
  assert.equal(calibrateAppGaps(gaps,[fact()]).adjusted,0);
  assert.equal(calibrateAppGaps([gap('开发文档编写')],[fact(),fact('从未做过开发文档编写。')]).adjusted,0);
});

test('matching preserves raw score and specialist gates while calibrating ordinary app workflow gaps',async()=>{
  await withModel(body=>({...goodResponse(body),gaps:[gap('需求分析与开发文档、自测')]}),async config=>{
    const dir=await mkdtemp('/tmp/jp-baseline-'),store=new Store(dir);try{
      const job=prepare(store,config);store.addFact({expectedVersion:store.resume().version,text:baseline,category:'experience'});
      const added=store.resume().facts.find(x=>x.text===baseline)!;store.updateFact({id:added.id,expectedVersion:added.version,approved:true});store.freezeResume(store.resume().version);
      const core=new MatchingService(store,()=>config),report=await core.analyze(job.id,new AbortController().signal);
      assert.equal(report.score,90);assert.equal(report.decision,'RECOMMEND');assert.equal(report.gaps[0].severity,'soft');assert(report.reasons.some(x=>x.code==='APP_BASELINE_REVIEW'));
      store.upsertJob({...job,id:'demo:kernel_baseline',platformJobId:'kernel_baseline',jdText:'负责App客户端及独立实现P2P协议栈内核。',jdHash:'kernel-baseline'});
      const kernel=await core.analyze('demo:kernel_baseline',new AbortController().signal);assert.equal(kernel.decision,'REVIEW');assert(kernel.gaps.some(x=>x.severity==='hard'&&/P2P/.test(x.requirement)));
    }finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('manual facts retain user source, start unapproved, invalidate old contexts and require explicit confirmation',async()=>{
  const dir=await mkdtemp('/tmp/jp-manual-fact-'),app=new Application(dir),signal=new AbortController().signal;
  try{
    assert.throws(()=>FactAdd.parse({expectedVersion:1,text:baseline,approved:true}));
    const state=await app.dispatch('resume.add',{expectedVersion:1,text:baseline,category:'experience',sourceQuote:'匿名用户明确说明能完整独立交付App。'},signal) as any;
    assert.equal(state.approvedCount,0);assert.equal(state.facts[0].source.kind,'text');assert.equal(state.facts[0].source.file,'用户补充');assert.equal(state.frozenVersion,null);
    assert.equal((await app.dispatch('resume.add',{expectedVersion:state.version,text:baseline,category:'experience'},signal) as any).facts.length,1);
    await assert.rejects(app.dispatch('resume.add',{expectedVersion:1,text:'另一条真实技能说明',category:'skill'},signal),{code:'VERSION_CONFLICT'});
    const f=state.facts[0];const reviewed=await app.dispatch('resume.update',{id:f.id,expectedVersion:f.version,approved:true},signal) as any;
    const frozen=await app.dispatch('resume.freeze',{expectedVersion:reviewed.version},signal) as any;assert.equal(frozen.approvedCount,1);
    const edited=await app.dispatch('resume.update',{id:f.id,expectedVersion:reviewed.facts[0].version,text:baseline+'可进一步核实。',approved:true},signal) as any;assert.equal(edited.approvedCount,0);assert.equal(edited.frozenVersion,null);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
