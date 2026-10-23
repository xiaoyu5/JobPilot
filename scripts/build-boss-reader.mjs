import {build} from 'esbuild';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
const output='.local/boss-reader';await mkdir(output,{recursive:true});
for(const name of ['manifest.json','popup.html','popup.js'])await copyFile(`extensions/boss-reader/${name}`,`${output}/${name}`);
const result=await build({entryPoints:['packages/boss-adapter/src/page-bridge.ts'],bundle:true,platform:'browser',target:'es2022',format:'iife',globalName:'JobPilotPageBridge',write:false});
// A final expression is needed for Chrome's executeScript result; diagnostics are business key names only.
await writeFile(`${output}/bridge.js`,`(() => {${result.outputFiles[0].text}\nreturn JobPilotPageBridge.connectReadOnlyBridge();})()`);
console.log('Built BOSS reader in .local/boss-reader. Single-click mode by default; remembered site access is optional and requires the user. Not installed or enabled.');
