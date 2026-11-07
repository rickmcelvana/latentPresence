// `pnpm plugin:index --out <index.json> <plugin folder>…` (ADR-72 item 9, P10-T09).
//
// Writes each plugin's entry into the index, read from a **pushed commit** of this repository,
// not the working tree: the manifest's address names that commit on raw.githubusercontent.com
// (which sends CORS), so what was listed can never change under the index. `--commit <sha>`
// picks the commit (HEAD by default). Tags already in the index are kept.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { PluginFolder } from '@latentpresence/core';
import { PluginIndexSchema, type PluginIndex } from '@latentpresence/protocol';
import { sha256Hex } from './folder';
import { indexEntry, withEntries } from './listing';

const RAW = 'https://raw.githubusercontent.com/rickmcelvana/latentPresence';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
const out = flag('--out');
const dirs = args.filter((arg, at) => !arg.startsWith('--') && args[at - 1] !== '--out' && args[at - 1] !== '--commit');
if (out === undefined || dirs.length === 0) {
  console.error('Usage: pnpm plugin:index --out <index.json> [--commit <sha>] <plugin folder>…');
  process.exit(2);
}

const git = (...gitArgs: string[]): Buffer => execFileSync('git', gitArgs, { maxBuffer: 64 * 1024 * 1024 });
const top = git('rev-parse', '--show-toplevel').toString().trim();
const commit = git('rev-parse', flag('--commit') ?? 'HEAD').toString().trim();
if (git('branch', '-r', '--contains', commit).toString().trim() === '') {
  console.error(`${commit.slice(0, 7)} is not on any pushed branch: push it first, or the index would point at nothing.`);
  process.exit(1);
}

/** A plugin folder as it is in that commit. */
function commitFolder(path: string): PluginFolder {
  const read = (file: string): Buffer | null => {
    try {
      return git('show', `${commit}:${path}/${file}`);
    } catch {
      return null;
    }
  };
  return {
    bytes: async (file) => {
      const buffer = read(file);
      return buffer === null ? null : new Uint8Array(buffer);
    },
    text: async (file) => read(file)?.toString('utf8') ?? null,
  };
}

const existing: PluginIndex | null = existsSync(out) ? PluginIndexSchema.parse(JSON.parse(readFileSync(out, 'utf8'))) : null;
const entries = [];
for (const dir of dirs) {
  const path = relative(top, resolve(dir)).replaceAll('\\', '/');
  const id = (JSON.parse(git('show', `${commit}:${path}/plugin.json`).toString()) as { id?: string }).id;
  const tags = existing?.plugins.find((plugin) => plugin.id === id)?.tags ?? [];
  const entry = await indexEntry(commitFolder(path), `${RAW}/${commit}/${path}/plugin.json`, sha256Hex, tags);
  entries.push(entry);
  console.log(`${entry.name} ${entry.version} (${entry.id}): ${Object.keys(entry.files).length + 1} files pinned at ${commit.slice(0, 7)}`);
}
writeFileSync(out, `${JSON.stringify(withEntries(existing, entries), null, 2)}\n`);
console.log(`wrote ${out}`);
