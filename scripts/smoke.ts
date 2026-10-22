import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { callWorker } from '../packages/worker/src/client.js';
import type { WorkerStatus } from '@jobpilot/contracts';

const dir = await mkdtemp('/tmp/jp-smoke-');
const node = resolve('apps/desktop/src-tauri/binaries/jobpilot-node-aarch64-apple-darwin');
const script = resolve('dist/worker/index.mjs');
const worker = spawn(node, [script, '--mode', 'worker', '--data-dir', dir], {stdio: ['ignore', 'ignore', 'inherit'], env: {...process.env, NODE_OPTIONS: '', NODE_PATH: ''}});
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let client: Client | undefined;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await callWorker(dir, 'status', undefined, 1000)).ok) { ready = true; break; } } catch {} await wait(100); }
  assert(ready, 'worker should become ready');
  const status = (await callWorker(dir, 'status')).data as WorkerStatus;
  assert.equal(status.node, '22.23.2'); assert.equal(status.arch, 'arm64');
  const duplicate = spawn(node, [script, '--mode', 'worker', '--data-dir', dir], {stdio: 'ignore'});
  const code = await new Promise(resolve => duplicate.once('exit', resolve));
  assert.equal(code, 0); assert.equal(((await callWorker(dir, 'status')).data as WorkerStatus).pid, status.pid);
  console.log('PASS: bundled Node, single-worker ownership');
  client = new Client({name: 'jobpilot-m0-smoke', version: '0.0.1'});
  await client.connect(new StdioClientTransport({command: node, args: [script, '--mode', 'mcp', '--data-dir', dir]}));
  await client.ping();
  const tools = await client.listTools(); assert.equal(tools.tools.length, 10);
  const readText = (value: any) => JSON.parse(value.content[0].text);
  assert.equal(readText(await client.callTool({name: 'jobpilot.status', arguments: {}})).data.pid, status.pid);
  assert.equal(readText(await client.callTool({name: 'jobpilot.start_run', arguments: {profileId: 'test', mode: 'auto'}})).error.code, 'CONSENT_REQUIRED');
  console.log('PASS: real MCP SDK v2 stdio initialize/list/call, Auto gate');
  if (process.env.JOBPILOT_SMOKE_CHROME === '1') {
    assert.equal((await callWorker(dir, 'browser.open')).ok, true);
    assert.equal((await callWorker(dir, 'browser.open')).ok, true);
    assert.equal((await callWorker(dir, 'browser.close')).ok, true);
    assert((await stat(`${dir}/chrome-profile/Default/Preferences`)).isFile());
    assert.equal((await callWorker(dir, 'browser.open')).ok, true);
    assert.equal((await callWorker(dir, 'browser.close')).ok, true);
    console.log('PASS: visible Chrome, dedicated persistent profile, close/reopen');
  }
  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_MODEL) {
    const result = await callWorker(dir, 'llm.test', {baseUrl: process.env.OPENAI_BASE_URL, model: process.env.OPENAI_MODEL, apiKey: process.env.OPENAI_API_KEY || undefined});
    console.log('Cockpit diagnostic:', JSON.stringify(result));
    assert.equal(result.ok, true); assert.equal((result.data as any).healthy, true);
    console.log('PASS: live Cockpit chat and JSON validation');
  }
} finally {
  await client?.close();
  await callWorker(dir, 'shutdown', undefined, 3000).catch(() => {});
  if (worker.exitCode === null) await Promise.race([new Promise(resolve => worker.once('exit', resolve)), wait(5000)]);
  if (worker.exitCode === null) worker.kill('SIGTERM');
  await rm(dir, {recursive: true, force: true});
}
