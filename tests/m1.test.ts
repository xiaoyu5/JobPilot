import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Store } from '@jobpilot/store';
import { parseResumeFile } from '@jobpilot/resume';
import { Application } from '../packages/worker/src/application.js';
import { demoJobs } from '../fixtures/boss/demo-jobs.js';
import { docxFixture, pdfFixture } from './fixtures.js';

test('DOCX and PDF extraction retain sources and never invent approval', async () => {
  const dir = await mkdtemp('/tmp/jp-resume-');
  try {
    const docx = await parseResumeFile(await docxFixture(dir));
    assert(docx.facts.some(fact => fact.category === 'skill' && fact.text.includes('Swift')));
    assert(docx.facts.some(fact => fact.category === 'project' && fact.text.includes('BLE')));
    assert(docx.facts.every(fact => fact.source.file === 'anonymous-resume.docx' && fact.source.paragraph > 0));
    const pdf = await parseResumeFile(await pdfFixture(dir));
    assert(pdf.facts.some(fact => fact.text.includes('Swift') && fact.source.page === 1));
    await writeFile(`${dir}/broken.pdf`, 'not a PDF');
    await assert.rejects(parseResumeFile(`${dir}/broken.pdf`), {code:'PARSE_FAILED'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('SQLite facts require explicit review, edits revoke approval, snapshots and stale edits are safe', async () => {
  const dir = await mkdtemp('/tmp/jp-store-'); let store = new Store(dir);
  try {
    const parsed = await parseResumeFile(await docxFixture(dir));
    let state = store.importFacts(parsed.file,parsed.hash,parsed.facts);
    assert.equal(state.approvedCount,0); assert.equal(state.frozenVersion,null);
    assert.throws(()=>store.freezeResume(state.version),{code:'NO_APPROVED_FACTS'});
    const fact = state.facts.find(fact=>fact.category==='skill')!;
    state = store.updateFact({id:fact.id,expectedVersion:fact.version,approved:true});
    const frozen = store.freezeResume(state.version); assert.equal(frozen.approvedCount,1);
    assert.equal(JSON.parse((store.db.prepare('SELECT facts_json FROM resume_snapshots').get() as any).facts_json).length,1);
    assert.throws(()=>store.updateFact({id:fact.id,expectedVersion:fact.version,approved:true}),{code:'VERSION_CONFLICT'});
    const current = state.facts.find(item=>item.id===fact.id)!;
    state = store.updateFact({id:fact.id,expectedVersion:current.version,text:'修正后的匿名 Swift 项目事实',approved:true});
    assert.equal(state.approvedCount,0); assert.equal(state.frozenVersion,null);
    assert.throws(()=>store.importFacts(parsed.file,parsed.hash,parsed.facts),{code:'RESUME_ALREADY_IMPORTED'});
    const version = state.version;
    store.close(); store = new Store(dir);
    assert.equal(store.resume().version,version);
    assert.equal(store.resume().facts.find(item=>item.id===fact.id)!.text,'修正后的匿名 Swift 项目事实');
    assert.equal((await stat(`${dir}/jobpilot.sqlite`)).mode&0o777,0o600);
  } finally { store.close(); await rm(dir,{recursive:true,force:true}); }
});

test('jobs deduplicate, configuration survives restart and interrupted discovery needs a human', async () => {
  const dir = await mkdtemp('/tmp/jp-persist-'); let store = new Store(dir);
  try {
    for(const job of [...demoJobs(),...demoJobs()])store.upsertJob(job);
    assert.equal(store.dashboard().totalJobs,20);
    assert.equal(store.listJobs({source:'boss',limit:50,offset:0}).total,0);
    assert.equal(store.listJobs({query:'匿名示例公司 A',limit:10,offset:0}).total,1);
    store.updateConfig({llm:{baseUrl:'http://localhost:1/v1',model:'fixture-model',timeoutMs:1000,allowLan:false}});
    const profile={...store.getSearch()!,name:'持久化测试',maxJobs:7};store.saveSearch(profile);
    const run=store.createRun('boss'); store.incrementRun(run.id);
    store.close();store=new Store(dir);
    assert.equal(store.config().llm?.model,'fixture-model');assert.equal(store.getSearch()!.maxJobs,7);
    assert.equal(store.getRun(run.id)!.state,'NEEDS_HUMAN');assert.equal(store.getRun(run.id)!.discoveredCount,1);
    assert.equal(store.events(run.id)[0].type,'WORKER_INTERRUPTED');
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
});

test('M1 use cases reject secrets in settings and enforce consent, one run and pause on revocation', async () => {
  const dir=await mkdtemp('/tmp/jp-usecase-');const app=new Application(dir);const signal=new AbortController().signal;
  try {
    await assert.rejects(app.dispatch('config.update',{llm:{baseUrl:'http://localhost:1/v1',model:'fixture',apiKey:'fixture-secret'}},signal));
    assert.equal((await readFile(`${dir}/jobpilot.sqlite`)).includes('fixture-secret'),false);
    await app.dispatch('search.save',{...app.store.getSearch()!,searchUrl:'https://www.zhipin.com/web/geek/jobs?city=101280600&token=unrelated-fixture-token'},signal);
    assert.equal(new URL(app.store.getSearch()!.searchUrl).searchParams.get('city'),'101280600');
    assert.equal(app.store.getSearch()!.searchUrl.includes('unrelated-fixture-token'),false);
    await assert.rejects(app.dispatch('run.start',{profileId:'primary',mode:'preview'},signal),{code:'CONSENT_REQUIRED'});
    await assert.rejects(app.dispatch('run.start',{profileId:'primary',mode:'auto'},signal),{code:'CONSENT_REQUIRED'});
    await app.dispatch('config.update',{bossReadOnlyConsent:true},signal);
    app.browser.search=async(_profile,abortSignal)=>new Promise((_,reject)=>abortSignal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
    const started=await app.dispatch('run.start',{profileId:'primary',mode:'preview'},signal) as {runId:string};
    await assert.rejects(app.dispatch('run.start',{profileId:'primary',mode:'preview'},signal),{code:'RUN_ACTIVE'});
    await app.dispatch('config.update',{bossReadOnlyConsent:false},signal);
    for(let i=0;i<30&&app.store.getRun(started.runId)!.state==='DISCOVERING';i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(app.store.getRun(started.runId)!.state,'PAUSED');assert.equal(app.store.getRun(started.runId)!.errorCode,'USER_PAUSED');
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
test('preview reads JD only for job IDs discovered in the current run',async()=>{
  const dir=await mkdtemp('/tmp/jp-discovery-');const app=new Application(dir);const signal=new AbortController().signal;
  try{
    const current={...demoJobs()[0],id:'boss:current',platformJobId:'current',source:'boss' as const,url:'https://www.zhipin.com/job_detail/current.html',jdText:'',jdHash:''};
    app.store.upsertJob({...current,id:'boss:unrelated',platformJobId:'unrelated',fetchedAt:'2099-01-01T00:00:00.000Z'});
    app.store.updateConfig({bossReadOnlyConsent:true});app.store.saveSearch({...app.store.getSearch()!,maxJobs:1});
    app.browser.search=async(_profile,_signal,onJob)=>{onJob(current);return 1;};
    const readIds:string[]=[];
    app.browser.readJob=async job=>{readIds.push(job.id);return {...job,jdText:'匿名本次岗位 JD',jdHash:'fixture-hash'};};
    const {runId}=await app.dispatch('run.start',{profileId:'primary',mode:'preview'},signal) as {runId:string};
    for(let i=0;i<30&&app.store.getRun(runId)!.state==='DISCOVERING';i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(app.store.getRun(runId)!.state,'COMPLETED');assert.deepEqual(readIds,['boss:current']);
    assert.equal(app.store.getJob('boss:current')!.jdText,'匿名本次岗位 JD');assert.equal(app.store.getJob('boss:unrelated')!.jdText,'');
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
