import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Store} from '@jobpilot/store';
import {MatchingService} from '@jobpilot/core';
import {withModel,goodResponse,prepare} from './m2-fixtures.js';

function approveAll(store:Store){
  for(const f of store.resume().facts.filter(f=>!f.approved))store.updateFact({id:f.id,expectedVersion:f.version,approved:true});
  store.freezeResume(store.resume().version);
}

test('major-only requirements receive confirmed education even after more than 50 relevant project facts',async()=>{
  await withModel(body=>{
    const input=JSON.parse(body.messages[1].content);
    assert(input.approvedFacts.some((f:any)=>f.text==='本科 | 计算机科学与技术'));
    assert(input.approvedFacts.length<=50);
    assert(!input.approvedFacts.some((f:any)=>f.text==='尚未确认的其他学历'));
    return goodResponse(body);
  },async config=>{
    const dir=await mkdtemp('/tmp/jp-major-retrieval-'),store=new Store(dir);
    try{
      const job=prepare(store,config);
      store.importFacts('anonymous-long-cv.txt',randomUUID(),Array.from({length:60},(_,i)=>({text:`项目${i+1}：负责 Swift 客户端模块开发与维护。`,category:'project',source:{file:'anonymous-long-cv.txt',kind:'text' as const,paragraph:i+1,quote:'匿名测试项目事实。'}})));
      store.addFact({expectedVersion:store.resume().version,text:'本科 | 计算机科学与技术',category:'education'});approveAll(store);
      store.addFact({expectedVersion:store.resume().version,text:'尚未确认的其他学历',category:'education'});store.freezeResume(store.resume().version);
      store.upsertJob({...job,jdText:'要求计算机科学与技术、软件工程等相关专业，负责 Swift 客户端开发。',jdHash:'major-without-degree-keyword'});
      const result=await new MatchingService(store,()=>config).analyze(job.id,new AbortController().signal);
      assert.equal(result.score,90);assert.equal(result.decision,'RECOMMEND');
    }finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('concise greeting uses a relevant complete project fact rather than only generic workflow evidence',async()=>{
  const generic='具备常规App需求分析、开发文档编写与自测能力。';
  const project='匿名摄像头：云视频模块化：以 Flutter 混合开发抽离云视频播放模块并接入原生工程，视频业务可独立迭代。';
  await withModel((body,calls)=>{
    const input=JSON.parse(body.messages[1].content);
    if(!input.statements){const f=input.approvedFacts.find((f:any)=>f.text===generic);return {score:90,decision:'RECOMMEND',strengths:[{requirement:'App交付流程',factId:f.factId,reason:f.text}],gaps:[],evidenceFactIds:[f.factId]};}
    assert(input.statements.some((s:any)=>s.text===project),'relevant project details may support a greeting even when omitted from the short strength list');
    const specific=input.statements.find((s:any)=>s.text===project),basic=input.statements.find((s:any)=>s.text===generic);
    assert(input.preferredProjectStatementIds.includes(specific.id));
    // The first generic-only answer must fail validation; the one permitted repair uses the project.
    return {opening:'direction',statementIds:[calls===2?basic.id:specific.id],closing:'discuss'};
  },async(config,calls)=>{
    const dir=await mkdtemp('/tmp/jp-project-greeting-'),store=new Store(dir);
    try{
      const job=prepare(store,config);
      for(const [text,category] of [[generic,'skill'],[project,'project']] as const)store.addFact({expectedVersion:store.resume().version,text,category});
      approveAll(store);store.upsertJob({...job,title:'iOS 客户端工程师',jdText:'负责 iOS 客户端，熟悉 Flutter 混合模块开发者优先。',jdHash:'client-flutter'});
      const core=new MatchingService(store,()=>config),signal=new AbortController().signal;await core.analyze(job.id,signal);
      const draft=await core.generate(job.id,'concise',signal);
      assert.equal(calls(),3);assert.equal(draft.audit.status,'PASS');assert(draft.content.includes(project));assert(!draft.content.includes(generic));
      assert([...draft.content].length>=50&&[...draft.content].length<=100);assert.equal(draft.statements[0].text,project);
      assert.equal(core.validateForSend(draft.id).draft.content,draft.content);
    }finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
});

test('manual greeting edits can replace whole evidence with another frozen fact while partial rewrites stay blocked',async()=>{
  await withModel(goodResponse,async config=>{
    const dir=await mkdtemp('/tmp/jp-edit-evidence-'),store=new Store(dir);
    const concise='我有多年iOS开发经验，曾独立完成Swift客户端开发与上线；仅集成P2P SDK，未独立实现协议栈。';
    try{
      const job=prepare(store,config);store.addFact({expectedVersion:store.resume().version,text:concise,category:'project'});approveAll(store);
      const confirmed=store.resume().facts.find(f=>f.text===concise)!,core=new MatchingService(store,()=>config),signal=new AbortController().signal;
      await core.analyze(job.id,signal);const original=await core.generate(job.id,'natural',signal),queued=core.queue(job.id,original.id);core.review(queued.queueItemId,1);
      const content='您好，'+concise+'希望了解贵司iOS岗位，方便进一步交流吗？',edited=core.updateDraft(original.id,1,content);
      assert.equal(edited.audit.status,'PASS');assert.deepEqual(edited.factIds,[confirmed.id]);assert.equal(edited.statements[0].text,concise);assert.equal(core.listQueue()[0].state,'PENDING');
      assert.deepEqual(JSON.parse(String(store.db.prepare('SELECT fact_ids_json FROM greeting_drafts WHERE id=?').get(original.id)!.fact_ids_json)),[confirmed.id]);
      assert.equal(core.validateForSend(edited.id).draft.content,content);
      const partial=core.updateDraft(edited.id,2,content.replace('未独立实现','独立实现'));assert.equal(partial.audit.status,'BLOCK');assert.equal(core.listQueue()[0].state,'BLOCKED');
      assert.equal(core.updateDraft(edited.id,3,content).audit.status,'PASS');
    }finally{store.close();await rm(dir,{recursive:true,force:true});}
  });
});
