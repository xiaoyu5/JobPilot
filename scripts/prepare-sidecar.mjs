import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('M0 packaging supports macOS arm64 only.');
const version = '22.23.2';
const archiveName = `node-v${version}-darwin-arm64.tar.gz`;
const sha256 = '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6';
const downloads = resolve('.tools/downloads');
await mkdir(downloads, {recursive: true});
const archive = `${downloads}/${archiveName}`;
if (!existsSync(archive)) {
  const response = await fetch(`https://nodejs.org/dist/v${version}/${archiveName}`);
  if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
}
const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
if (actual !== sha256) throw new Error('Node archive checksum mismatch.');
execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', downloads]);
const destination = 'apps/desktop/src-tauri/binaries';
await mkdir(destination, {recursive: true});
await copyFile(`${downloads}/node-v${version}-darwin-arm64/bin/node`, `${destination}/jobpilot-node-aarch64-apple-darwin`);
await chmod(`${destination}/jobpilot-node-aarch64-apple-darwin`, 0o755);
await mkdir('apps/desktop/src-tauri/resources/notices', {recursive: true});
await copyFile(`${downloads}/node-v${version}-darwin-arm64/LICENSE`, 'apps/desktop/src-tauri/resources/notices/NODE_LICENSE');
console.log(`Prepared official Node ${version} arm64; SHA-256 verified.`);
