import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Produces upload files only. Never starts the app, opens BOSS or publishes a release.
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: root, encoding: 'utf8', ...options });
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const config = JSON.parse(await readFile(resolve(root, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(config.version, pkg.version, 'Package and app versions must match.');
assert.equal(process.platform, 'darwin', 'Release inspection requires macOS.');
const { version, productName } = config;
const name = `${productName}_${version}_aarch64.dmg`;
const image = resolve(root, `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/${name}`);
const releases = resolve(root, '.local/releases');
await mkdir(releases, { recursive: true });
const destination = resolve(releases, version);
assert.equal(await lstat(destination).then(() => true, () => false), false, 'Release directory already exists; move it aside before preparing a new candidate.');
const stage = await mkdtemp(resolve(releases, `.prepare-${version}-`));
const temporary = await mkdtemp('/private/tmp/jobpilot-release-');
const mount = resolve(temporary, 'volume');
let mounted = false;
async function detach() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = spawnSync('/usr/bin/hdiutil', ['detach', mount], { encoding: 'utf8' });
    if (result.status === 0) { mounted = false; return; }
    if (attempt === 19) throw new Error('Could not detach the owned read-only release volume; temporary directory retained.');
    await delay(250);
  }
}
try {
  await mkdir(mount);
  run('/usr/bin/hdiutil', ['verify', image]);
  run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image]);
  mounted = true;
  const app = resolve(temporary, `${productName}.app`);
  run('/usr/bin/ditto', [resolve(mount, `${productName}.app`), app]);
  await detach();
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: ['ignore', 'pipe', 'pipe'] });
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', `${app}/Contents/Info.plist`]));
  assert.equal(info.CFBundleShortVersionString, version, 'DMG contains a different version.');
  assert.equal(info.CFBundleIdentifier, config.identifier);
  // codesign writes display information to stderr, so collect it separately.
  const display = spawnSync('/usr/bin/codesign', ['-d', '--verbose=2', app], { encoding: 'utf8' });
  assert.equal(display.status, 0);
  assert.match(display.stderr, /Signature=adhoc/, 'This release path documents an ad-hoc, unnotarized build. Use a separate process for Developer ID releases.');
  let inspectedFiles = 0;
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!/^(?:\.env(?:\..*)?|chrome-profile|jobpilot\.sqlite.*|.*\.(?:sqlite(?:3)?|db|sock|token|p12|key|mobileprovision|docx))$/i.test(entry.name), 'Private data filename found in app resources.');
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in release resources; inspect before publishing.');
      else inspectedFiles++;
    }
  }
  await inspect(`${app}/Contents`);
  const shippedNode = run(`${app}/Contents/MacOS/jobpilot-node`, ['--version'], { env: { PATH: '/usr/bin:/bin' } }).trim();
  assert.equal(shippedNode, `v${pkg.engines.node}`);
  await copyFile(image, resolve(stage, name));

  run(process.execPath, ['scripts/build-boss-reader.mjs']);
  const reader = resolve(root, '.local/boss-reader');
  const manifest = JSON.parse(await readFile(resolve(reader, 'manifest.json'), 'utf8'));
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['https://www.zhipin.com/*']);
  assert.equal(manifest.background, undefined);
  const extensionFolder = resolve(temporary, 'JobPilot-BOSS-Reader');
  await mkdir(extensionFolder);
  for (const file of ['manifest.json', 'popup.html', 'popup.js', 'bridge.js']) {
    await copyFile(resolve(reader, file), resolve(extensionFolder, file));
  }
  await copyFile(resolve(root, 'extensions/boss-reader/README.md'), resolve(extensionFolder, 'README.md'));
  const extensionName = `JobPilot_BOSS_Reader_${manifest.version}.zip`;
  run('/usr/bin/zip', ['-q', '-X', '-r', resolve(stage, extensionName), 'JobPilot-BOSS-Reader'], { cwd: temporary });
  await copyFile(resolve(root, 'docs/install-macos.md'), resolve(stage, 'INSTALL-macOS.md'));
  await copyFile(resolve(root, `docs/releases/${version}.md`), resolve(stage, 'RELEASE-NOTES.md'));
  const files = await Promise.all([name, extensionName, 'INSTALL-macOS.md', 'RELEASE-NOTES.md'].map(async file => ({
    name: file, bytes: (await lstat(resolve(stage, file))).size, sha256: await hash(resolve(stage, file)),
  })));
  const report = { version, architecture: 'aarch64', minimumMacOS: config.bundle.macOS.minimumSystemVersion,
    signing: 'ad-hoc', notarized: false, realSendingAcceptance: 'pending', shippedNode,
    checks: { dmgIntegrity: true, appSignatureStructure: true, appVersion: true, resourceFilenameInspection: true, inspectedFiles, extensionPermissions: true }, files };
  await writeFile(resolve(stage, 'release-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  const checksums = [...files, { name: 'release-manifest.json', sha256: await hash(resolve(stage, 'release-manifest.json')) }];
  await writeFile(resolve(stage, 'SHA256SUMS.txt'), checksums.map(file => `${file.sha256}  ${file.name}\n`).join(''));
  await rename(stage, destination);
  console.log(`Prepared ${basename(destination)} release files in .local/releases/${version}; no upload or BOSS action performed.`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (mounted) await detach();
  await rm(temporary, { recursive: true, force: true });
  await rm(stage, { recursive: true, force: true });
}
