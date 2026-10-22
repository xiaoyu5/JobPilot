import { createServer, type Socket } from 'node:net';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { ZodError } from 'zod';
import { AppError, MAX_FRAME_BYTES, RpcRequest, type Envelope } from '@jobpilot/contracts';
import { Application } from './application.js';
import { runtimePaths } from './paths.js';
import {recoverPendingData} from './data.js';

export async function startWorker(dataDir?: string,options:{guiToken?:string;application?:ConstructorParameters<typeof Application>[1]}={}) {
  process.umask(0o077);
  const paths = runtimePaths(dataDir);
  await mkdir(paths.root, {recursive: true, mode: 0o700}); await chmod(paths.root, 0o700);
  let release: () => Promise<void>;
  try { release = await lockfile.lock(paths.root, {realpath: true, stale: 10000, update: 2000, retries: 0}); }
  catch { throw new AppError('WORKER_ACTIVE', '已有 Worker，或上次崩溃的锁仍在 10 秒恢复保护期内。'); }
  let application: Application;
  try { const recoveryError=await recoverPendingData(paths.root); application = new Application(paths.root,options.application);if(recoveryError)application.store.setSetting('dataOperationError',recoveryError); } catch (error) { await release(); throw error; }
  const sockets = new Set<Socket>();
  const pending = new Set<AbortController>();
  const operations = new Set<Promise<void>>();
  const token = randomBytes(32).toString('hex');
  let closing = false, closePromise: Promise<void> | undefined;
  const server = createServer(socket => {
    if (closing || sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket);
    const controller = new AbortController(); pending.add(controller);
    socket.setTimeout(190000, () => socket.destroy());
    socket.on('close', () => { sockets.delete(socket); controller.abort(); pending.delete(controller); });
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0), consumed = false;
    socket.on('data', (chunk: Buffer) => {
      if (consumed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) { consumed = true; socket.destroy(); return; }
      const newline = buffer.indexOf(10); if (newline < 0) return;
      consumed = true;
      const operation = (async () => {
        let requestId: string | null = null;
        const traceId = randomUUID(); let result: Envelope, shutdown = false;
        try {
          const request = RpcRequest.parse(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
          requestId = request.requestId;
          if (!timingSafeEqual(Buffer.from(request.token, 'hex'), Buffer.from(token, 'hex'))) throw new AppError('UNAUTHORIZED', 'IPC token 无效。');
          if (closing) throw new AppError('WORKER_STOPPING', 'Worker 正在退出。');
          const guiAuthorized=!!options.guiToken&&!!request.guiToken&&timingSafeEqual(Buffer.from(request.guiToken,'hex'),Buffer.from(options.guiToken,'hex'));
          const data = request.action === 'shutdown' ? (shutdown = true, {accepted: true}) : await application.dispatch(request.action, request.payload, controller.signal,guiAuthorized);
          result = {ok: true, data, error: null, runId: typeof data === 'object' && data && 'runId' in data ? String(data.runId) : null, traceId};
        } catch (error) {
          result = {ok: false, data: null, runId: null, traceId, error: {code: error instanceof AppError ? error.code : error instanceof ZodError || error instanceof SyntaxError ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : '请求无效或操作失败，请检查参数及本地运行状态。'}};
        }
        let response = JSON.stringify({jsonrpc: '2.0', requestId, result}) + '\n';
        if (Buffer.byteLength(response) > MAX_FRAME_BYTES) response = JSON.stringify({jsonrpc: '2.0', requestId, result: {ok: false, data: null, runId: null, traceId, error: {code: 'FRAME_TOO_LARGE', message: '结果过大，请缩小查询范围。'}}}) + '\n';
        socket.end(response);
        if (shutdown) setImmediate(() => void close());
      })();
      operations.add(operation); void operation.finally(() => operations.delete(operation));
    });
  });
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true; for (const controller of pending) controller.abort(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await application.prepareShutdown();
    await Promise.allSettled([...operations]);
    try { await application.close(); } finally { await rm(paths.socket, {force: true}); await release(); }
  })();
  try {
    await writeFile(paths.token, token, {mode: 0o600}); await chmod(paths.token, 0o600); await rm(paths.socket, {force: true});
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.socket, () => resolve()); }); await chmod(paths.socket, 0o600);
  } catch (error) { await close(); throw error; }
  return {status: () => application.status(), close, server};
}
