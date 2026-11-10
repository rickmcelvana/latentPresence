// `pnpm plugin:check <folder> [--fetch] [--pin]` (ADR-72, P10-T01).
//
// Checks a plugin folder exactly as the app will when someone installs it, and says what is
// wrong in sentences. `--fetch` downloads every asset at an address and checks its bytes too.
// `--pin` first writes each asset's size and SHA-256 into plugin.json from the file or the
// address (for a new plugin, or after replacing an image), then checks with the downloads.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { diskFolder, fetchBytes, sha256Hex } from './folder';
import { pinAssets } from './pin';
import { checkFolder } from './run';

const args = process.argv.slice(2);
const dir = args.find((arg) => !arg.startsWith('--'));
const pin = args.includes('--pin');
const fetchAssets = pin || args.includes('--fetch');
if (dir === undefined) {
  console.error('Usage: pnpm plugin:check <plugin folder> [--fetch] [--pin]');
  process.exit(2);
}

const appConfig = new URL('../../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url);
const appVersion = (JSON.parse(await readFile(appConfig, 'utf8')) as { version: string }).version;

if (pin) {
  const path = join(dir, 'plugin.json');
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  const { manifest, pinned, failed } = await pinAssets(raw, diskFolder(dir), sha256Hex, fetchBytes);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Pinned ${pinned} asset${plural(pinned)} in ${path}.`);
  for (const line of failed) console.error(`  could not pin: ${line}`);
  if (failed.length > 0) process.exit(1);
}

const result = await checkFolder(dir, { fetch: fetchAssets, appVersion });
if (!result.ok) {
  console.error(`${resolve(dir)}: ${result.problems.length} problem${plural(result.problems.length)}`);
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exit(1);
}
const { manifest, assetBytes, promptTokens } = result.plugin;
const tables = Object.keys(manifest.data).length;
console.log(`${manifest.name} ${manifest.version} (${manifest.id}) is a valid plugin.`);
console.log(
  `  ${manifest.tools.length} tool${plural(manifest.tools.length)}, ${tables} table${plural(tables)}, ${manifest.assets.length} asset${plural(manifest.assets.length)} ` +
    `(${(assetBytes / 1_000_000).toFixed(1)} MB${fetchAssets ? ', every one downloaded and checked' : '; addresses not downloaded, add --fetch'})`,
);
console.log(`  prompt: about ${promptTokens.idle + promptTokens.used} tokens in every request while it is on, ${promptTokens.idle} if set to load only when needed (an estimate)`);
for (const note of result.notes) console.log(`  note: ${note}`);

function plural(count: number): string {
  return count === 1 ? '' : 's';
}
