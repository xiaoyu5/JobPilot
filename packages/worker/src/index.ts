import { parseArgs } from 'node:util';
import { AppError } from '@jobpilot/contracts';
import { startWorker } from './server.js';
import { callWorker } from './client.js';
import { startMcp } from '@jobpilot/mcp';

const {values} = parseArgs({options: {
  mode: {type: 'string', default: 'worker'}, 'data-dir': {type: 'string'}, 'parent-pid': {type: 'string'},
}});
const guiToken=process.env.JOBPILOT_GUI_TOKEN;
delete process.env.JOBPILOT_GUI_TOKEN;
try {
  if (values.mode === 'mcp') {
    startMcp((action, payload) => callWorker(values['data-dir'], action, payload));
  } else if (values.mode === 'worker') {
    let worker;
    try { worker = await startWorker(values['data-dir'],{guiToken:guiToken&&/^[a-f0-9]{64}$/.test(guiToken)?guiToken:undefined}); }
    catch (error) {
      if (error instanceof AppError && error.code === 'WORKER_ACTIVE') {
        const existing = await callWorker(values['data-dir'], 'status', undefined, 2000);
        if (existing.ok) { console.error('JobPilot: connected to existing worker.'); process.exit(0); }
      }
      throw error;
    }
    console.error('JobPilot M4 worker ready.');
    const stop = () => { void worker.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const parent = Number(values['parent-pid']);
    if (Number.isSafeInteger(parent) && parent > 1) {
      setInterval(() => { try { process.kill(parent, 0); } catch { stop(); } }, 1000).unref();
    }
  } else { throw new AppError('INVALID_MODE', 'mode must be worker or mcp'); }
} catch (error) {
  console.error(error instanceof AppError ? `${error.code}: ${error.message}` : 'WORKER_START_FAILED');
  process.exitCode = 1;
}
