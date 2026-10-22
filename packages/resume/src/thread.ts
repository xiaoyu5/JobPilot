import { parentPort, workerData } from 'node:worker_threads';
import { AppError } from '@jobpilot/contracts';
import { parseResumeFile } from './parser.js';
try { parentPort!.postMessage({ok: true, data: await parseResumeFile(workerData.path)}); }
catch (error) { parentPort!.postMessage({ok: false, code: error instanceof AppError ? error.code : 'PARSE_FAILED', message: error instanceof AppError ? error.message : '简历解析失败。'}); }
