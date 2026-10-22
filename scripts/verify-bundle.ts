import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { callWorker } from '../packages/worker/src/client.js';
import type { ResumeState, WorkerStatus, SendingStatus } from '@jobpilot/contracts';
import {randomUUID} from 'node:crypto';
import { docxFixture, pdfFixture } from '../tests/fixtures.js';
import {withModel,goodResponse,mapFact} from '../tests/m2-fixtures.js';
import type {Assessment,Draft} from '@jobpilot/contracts';

// Tauri intentionally rejects a macOS executable path containing symlinks.
// /tmp -> /private/tmp must be canonicalized before launching the copied App.
const {productName}=JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json','utf8'));
const bundle = await realpath(resolve(process.argv[2] ?? `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/${productName}.app`));
await withModel(goodResponse,async config=>{
const dir = await mkdtemp('/tmp/jp-bundle-');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let desktop: ChildProcess | undefined;
let client: Client | undefined;
try {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle], {stdio: 'inherit'});
  console.log('PASS: bundle signature structure (does not imply Developer ID or notarization)');
  const node = `${bundle}/Contents/MacOS/jobpilot-node`;
  const script = `${bundle}/Contents/Resources/worker/index.mjs`;
  assert.equal(execFileSync(node, ['--version'], {encoding: 'utf8', env: {PATH: '/usr/bin:/bin'}}).trim(), 'v22.23.2');
  console.log('PASS: shipped Node executes with system-only PATH');
  // AppKit's documented test-only option isolates window restoration from the user's real App.
  // https://developer.apple.com/library/archive/releasenotes/AppKit/RN-AppKitOlderNotes/
  const launch = () => spawn(`${bundle}/Contents/MacOS/jobpilot`, ['-ApplePersistenceIgnoreState','YES'], {
    env: {...process.env, PATH: '/usr/bin:/bin', JOBPILOT_DATA_DIR: dir, NODE_OPTIONS: '', NODE_PATH: ''},
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  async function ready() {
    for (let i = 0; i < 150; i++) {
      if (desktop && (desktop.exitCode !== null || desktop.signalCode !== null)) throw new Error(`Desktop exited: ${desktop.exitCode ?? desktop.signalCode}`);
      try {
        const result = await callWorker(dir, 'status', undefined, 500);
        if (result.ok) return result.data as WorkerStatus;
      } catch {}
      await wait(100);
    }
    throw new Error('Bundle worker did not become ready');
  }
  async function stop() {
    desktop?.kill('SIGTERM');
    for (let i = 0; i < 100; i++) {
      let offline = false;
      try { await callWorker(dir, 'status', undefined, 300); } catch { offline = true; }
      const locked = await stat(`${dir}.lock`).then(() => true, () => false);
      if (offline && !locked) return;
      await wait(100);
    }
    throw new Error('Worker outlived desktop');
  }
  desktop = launch();
  desktop.stderr?.on('data', data => process.stderr.write(data));
  const first = await ready();
  assert.equal(first.arch, 'arm64'); assert.equal(first.node, '22.23.2');
  assert.equal(first.milestone,'M4');assert.equal(first.autoModeConsent,false);assert.equal(first.mode,'preview');
  const actions=await stat(`${bundle}/Contents/Resources/worker/browser-actions.js`);assert(actions.size>0&&actions.size<256*1024);
  const duplicate = launch();
  for (let i = 0; i < 60 && duplicate.exitCode === null; i++) await wait(100);
  if (duplicate.exitCode === null) duplicate.kill('SIGTERM');
  assert.equal(duplicate.exitCode, 0, 'a second desktop instance should focus the first and exit');
  const afterDuplicate = await callWorker(dir, 'status');
  assert(afterDuplicate.ok); assert.equal((afterDuplicate.data as WorkerStatus).pid, first.pid);
  console.log('PASS: repeated desktop launch keeps one App/Worker and activates the existing window');
  async function call<T>(action: Parameters<typeof callWorker>[1], payload?: unknown): Promise<T> {
    const result = await callWorker(dir, action, payload);
    assert(result.ok, JSON.stringify(result.error)); return result.data as T;
  }
  const chats=await call<any>('chat.list');assert.equal(chats.autoEnabled,false);assert.equal(chats.items.length,0);assert.equal((await callWorker(dir,'chat.auto.set',{enabled:true,conversationIds:['fixture'],confirmed:true})).error?.code,'GUI_AUTH_REQUIRED');assert.equal((await callWorker(dir,'chat.commit',{id:randomUUID(),confirmed:true})).error?.code,'GUI_AUTH_REQUIRED');
  const sending=await call<SendingStatus>('send.status');assert.equal(sending.policy.liveEnabled,false);assert.equal(sending.policy.confirmed,false);assert.equal(sending.needsVerify,0);
  assert.equal((await callWorker(dir,'send.auto.set',{enabled:true})).error?.code,'GUI_AUTH_REQUIRED');
  assert.equal((await callWorker(dir,'send.commit',{planId:randomUUID(),confirmed:true})).error?.code,'GUI_AUTH_REQUIRED');
  assert.equal((await callWorker(dir,'run.start',{profileId:'primary',mode:'auto'})).error?.code,'CONSENT_REQUIRED');
  assert.equal((await call<{total:number}>('send.outbox')).total,0);
  assert.equal((await call<any>('data.status')).schema,5);assert.equal((await call<any>('stats.get')).replyRate,null);
  for(const action of ['diagnostics.export','data.backup','data.restore.prepare','data.restore.commit','data.reset','data.cleanup.preview','data.cleanup.commit','data.retention.save','outcomes.update'] as const)assert.equal((await callWorker(dir,action,{})).error?.code,'GUI_AUTH_REQUIRED');
  console.log('PASS: shipped M3 defaults to preview; native-only GUI authorization cannot be granted over ordinary IPC, with zero send intents');
  let resume = await call<ResumeState>('resume.import', {path: await docxFixture(dir)});
  resume = await call<ResumeState>('resume.import', {path: await pdfFixture(dir)});
  assert(resume.facts.some(fact => fact.source.kind === 'pdf'));
  const fact = resume.facts[0];
  resume = await call<ResumeState>('resume.update', {id: fact.id, expectedVersion: fact.version, approved: true});
  resume = await call<ResumeState>('resume.freeze', {expectedVersion: resume.version});
  await call('demo.load');
  for (let i = 0; i < 100; i++) {
    if ((await call<{total: number}>('jobs.list')).total === 20) break;
    await wait(50);
  }
  assert.equal((await call<{total: number}>('jobs.list')).total, 20);
  console.log('PASS: release resources parse DOCX/PDF in bounded worker threads and persist reviewed facts, frozen snapshot and 20 fixture jobs');
  assert.equal((await callWorker(dir, 'browser.open')).ok, true);
  assert.equal((await callWorker(dir, 'browser.close')).ok, true);
  assert((await stat(`${dir}/chrome-profile/Default/Preferences`)).isFile());
  console.log('PASS: release App starts bundled Worker and Chrome with isolated profile');
  client = new Client({name: 'jobpilot-bundle-check', version: '0.0.1'});
  await client.connect(new StdioClientTransport({command: node, args: [script, '--mode', 'mcp', '--data-dir', dir], env: {PATH: '/usr/bin:/bin'}}));
  await client.ping();
  assert.equal(client.getServerVersion()?.version,'0.4.0');
  const tools=await client.listTools();assert.equal(tools.tools.length,10);assert(!tools.tools.some(tool=>/commit|authorize|reset|restore|export/.test(tool.name)));
  const result = await client.callTool({name: 'jobpilot.status', arguments: {}});
  assert.equal(JSON.parse((result.content[0] as {text: string}).text).data.pid, first.pid);
  await client.close(); client = undefined;
  console.log('PASS: installed resources provide working MCP stdio gateway');

  const currentFact=(await call<ResumeState>('resume.list')).facts[0];
  resume=await call<ResumeState>('resume.update',{id:currentFact.id,expectedVersion:currentFact.version,text:mapFact,category:'project'});
  const editedFact=resume.facts.find(item=>item.id===currentFact.id)!;
  resume=await call<ResumeState>('resume.update',{id:editedFact.id,expectedVersion:editedFact.version,approved:true});
  resume=await call<ResumeState>('resume.freeze',{expectedVersion:resume.version});
  const {apiKey,...settings}=config;await call('config.update',{llm:settings});
  const job=(await call<any>('jobs.list')).items.find((item:any)=>/iOS/i.test(item.title));assert(job);
  const locked=await callWorker(dir,'analysis.analyze',{jobId:job.id});assert.equal(locked.error?.code,'LLM_LOCKED');
  await call('llm.env.save',config);
  const report=await call<Assessment>('analysis.analyze',{jobId:job.id});assert.equal(report.score,90);
  const draft=await call<Draft>('draft.generate',{jobId:job.id});assert.equal(draft.audit.status,'PASS');
  await call('queue.add',{jobId:job.id,draftId:draft.id});assert.equal((await call<any>('queue.list')).total,1);
  console.log('PASS: shipped M2 Worker loads private .env settings without Keychain; evidence, draft and local queue pass');

  await stop();
  desktop = launch();
  const second = await ready();
  assert.equal(second.llm.sessionReady,true,'restart should reload the saved env file without a password prompt');
  assert.equal(second.autoModeConsent,false);assert.equal((await call<any>('chat.list')).autoEnabled,false);assert.equal((await call<SendingStatus>('send.status')).policy.liveEnabled,false);assert.equal((await call<{total:number}>('send.outbox')).total,0);
  assert.notEqual(first.pid, second.pid);
  const restored = await call<ResumeState>('resume.list');
  assert.equal((await call<any>('queue.list')).items[0].draft.id,draft.id);
  assert.equal((await call<Assessment>('analysis.analyze',{jobId:job.id})).id,report.id);
  assert.equal(restored.version, resume.version); assert.equal(restored.frozenVersion, resume.frozenVersion);
  assert.equal((await call<{total: number}>('jobs.list')).total, 20);
  assert.equal((await callWorker(dir, 'browser.open')).ok, true);
  // Leave Chrome open: parent-death cleanup must close it and release the profile.
  await stop();
  console.log('PASS: desktop termination, parent-death cleanup and restart without worker/profile collision');
} finally {
  await client?.close(); desktop?.kill('SIGTERM');
  await callWorker(dir, 'shutdown', undefined, 3000).catch(() => {});
  await wait(1500);
  await rm(dir, {recursive: true, force: true});
}

});
