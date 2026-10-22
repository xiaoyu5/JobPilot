import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
await mkdir('apps/desktop/src-tauri/binaries',{recursive:true});
execFileSync('/usr/bin/xcrun',['swiftc','-O','-target','arm64-apple-macos13.0','-module-cache-path','.tools/swift-module-cache','native/browser/main.swift','-o','apps/desktop/src-tauri/binaries/jobpilot-browser-aarch64-apple-darwin'],{stdio:'inherit'});
