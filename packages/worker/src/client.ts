import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AppError, MAX_FRAME_BYTES, type Envelope, type Request } from '@jobpilot/contracts';
import { runtimePaths } from './paths.js';

export async function callWorker(dataDir: string | undefined, action: Request['action'], payload?: unknown, timeoutMs = 190000,guiToken?:string): Promise<Envelope> {
  const paths = runtimePaths(dataDir);
  const token = (await readFile(paths.token, 'utf8').catch(() => '')).trim();
  if (!token) throw new AppError('WORKER_OFFLINE', '请先启动 JobPilot 桌面应用或 Worker。');
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const socket = createConnection(paths.socket);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: Envelope) => {
      if (settled) return;
      settled = true; socket.destroy(); error ? reject(error) : resolve(value!);
    };
    socket.setTimeout(timeoutMs, () => finish(new AppError('IPC_TIMEOUT', 'Worker 请求超时。')));
    socket.on('error', () => finish(new AppError('WORKER_OFFLINE', 'Worker 连接不可用。')));
    socket.on('connect', () => socket.write(JSON.stringify({jsonrpc: '2.0', requestId, token, action, payload,guiToken}) + '\n'));
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) return finish(new AppError('FRAME_TOO_LARGE', 'IPC 响应过大。'));
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, end).toString('utf8'));
        if (response.requestId !== requestId) throw new Error('request id mismatch');
        finish(undefined, response.result);
      } catch { finish(new AppError('IPC_INVALID_RESPONSE', 'Worker 返回无效响应。')); }
    });
    socket.on('close', () => { if (!settled) finish(new AppError('IPC_CLOSED', 'Worker 提前关闭连接。')); });
  });
}
