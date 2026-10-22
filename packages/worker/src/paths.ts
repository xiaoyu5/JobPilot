import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError } from '@jobpilot/contracts';

export function runtimePaths(dataDir = join(homedir(), 'Library', 'Application Support', 'io.jobpilot.desktop')) {
  const root = resolve(dataDir);
  const socket = join(root, 'worker.sock');
  if (Buffer.byteLength(socket) > 100) throw new AppError('DATA_PATH_TOO_LONG', '数据路径过长，请选择更短的目录以容纳 macOS Unix socket。');
  return {root, socket, token: join(root, 'ipc.token')};
}
