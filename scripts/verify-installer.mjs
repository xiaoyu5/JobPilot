import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const {productName,version}=JSON.parse(await readFile('apps/desktop/src-tauri/tauri.conf.json','utf8'));
const image = resolve(process.argv[2] ?? `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/${productName}_${version}_aarch64.dmg`);
const temporary = await mkdtemp('/tmp/jp-install-');
const mount = `${temporary}/volume`;
const installed = `${temporary}/installed/${productName}.app`;
let attached = false;
try {
  await mkdir(mount); await mkdir(`${temporary}/installed`);
  execFileSync('/usr/bin/hdiutil', ['verify', image], {stdio: 'inherit'});
  execFileSync('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image], {stdio: 'inherit'});
  attached = true;
  execFileSync('/usr/bin/ditto', [`${mount}/${productName}.app`, installed]);
  execFileSync('/usr/bin/hdiutil', ['detach', mount], {stdio: 'inherit'});
  attached = false;
  console.log('PASS: DMG checksum verified; App copied out of read-only image to temporary installation.');
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/verify-bundle.ts', installed], {stdio: 'inherit'});
} finally {
  if (attached) execFileSync('/usr/bin/hdiutil', ['detach', mount], {stdio: 'inherit'});
  await rm(temporary, {recursive: true, force: true});
}
