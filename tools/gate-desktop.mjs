// `pnpm gate:desktop` (P8-T01): fmt, clippy and test for the desktop shell, on Windows only.
//
// The shell is a Windows app first (ADR-07), and compiling tauri on Linux needs webkit2gtk's
// development packages, which a contributor's Linux box and CI's ubuntu runner do not have.
// Windows has everything it needs, so the Windows gate (this machine, CI's windows-latest)
// checks the shell on every run and the others say they skipped it.
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('gate:desktop: skipped - the desktop shell is checked on Windows (ADR-07).');
  process.exit(0);
}

const manifest = ['--manifest-path', 'apps/desktop/src-tauri/Cargo.toml'];
const steps = [
  ['fmt', ...manifest, '--all', '--check'],
  ['clippy', ...manifest, '--all-targets', '--', '-D', 'warnings'],
  ['test', ...manifest],
];
for (const args of steps) {
  console.log(`gate:desktop: cargo ${args[0]}`);
  const result = spawnSync('cargo', args, { stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
