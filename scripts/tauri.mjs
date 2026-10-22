import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';

const root = resolve('.');
const env = {...process.env};
// Local Spike builds use a complete ad-hoc signature. A supplied Developer ID wins.
if (!env.APPLE_SIGNING_IDENTITY) env.APPLE_SIGNING_IDENTITY = '-';
// DMG generation does not need Finder automation for the M0 installer.
if (process.argv[2] === 'build') env.CI = 'true';
if (existsSync('.tools/cargo/bin/cargo')) {
  env.CARGO_HOME = resolve('.tools/cargo');
  env.RUSTUP_HOME = resolve('.tools/rustup');
  env.PATH = `${resolve('.tools/cargo/bin')}${delimiter}${env.PATH ?? ''}`;
}
const child = spawn(resolve('node_modules/.bin/tauri'), process.argv.slice(2), {
  cwd: `${root}/apps/desktop`, env, stdio: 'inherit',
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code ?? 1; });
