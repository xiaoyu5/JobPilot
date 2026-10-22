import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const snapshot=await build({entryPoints:['packages/boss-adapter/src/snapshot.ts'],bundle:true,platform:'browser',target:'es2022',format:'iife',globalName:'JobPilotSnapshot',write:false});
await mkdir('dist/worker',{recursive:true});
await writeFile('dist/worker/browser-snapshot.js',`(() => {${snapshot.outputFiles[0].text}\nreturn JSON.stringify(JobPilotSnapshot.snapshot());})()`);

const actions=await build({entryPoints:['packages/boss-adapter/src/actions.ts'],bundle:true,platform:'browser',target:'es2022',format:'iife',globalName:'JobPilotActions',write:false});
await writeFile('dist/worker/browser-actions.js',`(() => {${actions.outputFiles[0].text}\nreturn JSON.stringify(JobPilotActions.perform(__JOBPILOT_INPUT__));})()`);
