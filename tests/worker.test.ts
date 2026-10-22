import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { startWorker } from '../packages/worker/src/server.js';
import { callWorker } from '../packages/worker/src/client.js';
import { runtimePaths } from '../packages/worker/src/paths.js';

test('single owner, private IPC, authorization and restart', async () => {
  const dir = await mkdtemp('/tmp/jp-test-');
  let worker = await startWorker(dir);
  try {
    const status = await callWorker(dir, 'status');
    assert.equal(status.ok, true); assert.equal((status.data as any).mode, 'preview'); assert.equal((status.data as any).autoModeConsent, false);
    for (const path of [runtimePaths(dir).socket, runtimePaths(dir).token]) assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(startWorker(dir), {code: 'WORKER_ACTIVE'});
    assert.equal((await callWorker(dir, 'run.start', {profileId: 'test', mode: 'auto'})).error?.code, 'CONSENT_REQUIRED');
    assert.equal((await callWorker(dir, 'run.start', {profileId: 'primary', mode: 'preview'})).error?.code, 'CONSENT_REQUIRED');
    const oldToken = await readFile(runtimePaths(dir).token, 'utf8');
    const unauthorized = await new Promise<any>((resolve, reject) => {
      const socket = createConnection(runtimePaths(dir).socket);
      let response = '';
      socket.on('error', reject); socket.on('data', chunk => { response += chunk; });
      socket.on('end', () => resolve(JSON.parse(response)));
      socket.on('connect', () => socket.write(JSON.stringify({jsonrpc: '2.0', requestId: randomUUID(), token: '0'.repeat(64), action: 'status'}) + '\n'));
    });
    assert.equal(unauthorized.result.error.code, 'UNAUTHORIZED');
    await worker.close();
    worker = await startWorker(dir);
    assert.notEqual(await readFile(runtimePaths(dir).token, 'utf8'), oldToken);
    assert.equal((await callWorker(dir, 'status')).ok, true);
  } finally { await worker.close(); await rm(dir, {recursive: true, force: true}); }
});

test('offline gateway calls cannot bootstrap a worker or acquire browser ownership', async () => {
  const dir = await mkdtemp('/tmp/jp-offline-');
  try { await assert.rejects(callWorker(dir, 'status'), {code: 'WORKER_OFFLINE'}); }
  finally { await rm(dir, {recursive: true, force: true}); }
});
