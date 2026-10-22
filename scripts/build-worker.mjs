import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('dist/worker');
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
await build({
  entryPoints: ['packages/worker/src/index.ts'], outfile: `${output}/index.mjs`,
  bundle: true, platform: 'node', target: 'node22', format: 'esm',
  external: ['playwright-core', 'unpdf'],
  banner: {js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"},
});
await build({entryPoints: ['packages/resume/src/thread.ts'], outfile: `${output}/resume-parser.mjs`, bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['unpdf'], banner: {js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"}});
const snapshot=await build({entryPoints:['packages/boss-adapter/src/snapshot.ts'],bundle:true,platform:'browser',target:'es2022',format:'iife',globalName:'JobPilotSnapshot',write:false});
await writeFile(`${output}/browser-snapshot.js`,`(() => {${snapshot.outputFiles[0].text}\nreturn JSON.stringify(JobPilotSnapshot.snapshot());})()`);
const actions=await build({entryPoints:['packages/boss-adapter/src/actions.ts'],bundle:true,platform:'browser',target:'es2022',format:'iife',globalName:'JobPilotActions',write:false});
await writeFile(`${output}/browser-actions.js`,`(() => {${actions.outputFiles[0].text}\nreturn JSON.stringify(JobPilotActions.perform(__JOBPILOT_INPUT__));})()`);
await mkdir(`${output}/node_modules`, {recursive: true});
await cp('node_modules/playwright-core', `${output}/node_modules/playwright-core`, {recursive: true});
await cp('node_modules/unpdf', `${output}/node_modules/unpdf`, {recursive: true});
await mkdir(`${output}/node_modules/pdfjs-dist`, {recursive: true});
for (const asset of ['package.json', 'cmaps', 'standard_fonts', 'wasm', 'LICENSE']) await cp(`node_modules/pdfjs-dist/${asset}`, `${output}/node_modules/pdfjs-dist/${asset}`, {recursive: true});
await mkdir('apps/desktop/src-tauri/resources', {recursive: true});
await rm('apps/desktop/src-tauri/resources/worker', {recursive: true, force: true});
await cp(output, 'apps/desktop/src-tauri/resources/worker', {recursive: true});
console.log('Worker bundle and Playwright driver prepared. No Chromium download required.');
