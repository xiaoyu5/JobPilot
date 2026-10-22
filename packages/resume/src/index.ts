import { Worker } from 'node:worker_threads';
import { AppError } from '@jobpilot/contracts';
import { parseResumeFile, type ParsedResume } from './parser.js';

export {parseResumeFile};
export async function parseResume(path: string, signal?: AbortSignal): Promise<ParsedResume> {
  // Source tests use trusted generated fixtures. Release parsing runs in a bounded thread.
  if (import.meta.url.endsWith('.ts')) return parseResumeFile(path);
  return new Promise((resolve, reject) => {
    const thread = new Worker(new URL('./resume-parser.mjs', import.meta.url), {workerData: {path}, resourceLimits: {maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32}});
    let settled = false;
    const timer = setTimeout(() => finish(new AppError('PARSE_TIMEOUT', '简历解析超过 20 秒，请使用较简洁的 DOCX/PDF。')), 20000);
    function finish(error?: Error, value?: ParsedResume) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); void thread.terminate();
      error ? reject(error) : resolve(value!);
    }
    const abort = () => finish(new AppError('PARSE_CANCELLED', '解析已取消。'));
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    thread.on('message', message => message.ok ? finish(undefined, message.data) : finish(new AppError(message.code, message.message)));
    thread.on('error', () => finish(new AppError('PARSE_FAILED', '解析失败或文件资源消耗过大，请使用简洁的文本简历。')));
    thread.on('exit', () => { if (!settled) finish(new AppError('PARSE_FAILED', '解析线程意外退出。')); });
  });
}
