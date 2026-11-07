// `pnpm plugin:schema`: rewrites the JSON Schemas for `plugin.json` and the plugin index from the zod
// schemas (ADR-72). Run it after changing `plugin.ts`; `plugin.test.ts` fails until you do.
import { writeFileSync } from 'node:fs';
import { pluginIndexJsonSchema, pluginManifestJsonSchema } from '../src/index';

for (const [name, schema] of [
  ['plugin.schema.json', pluginManifestJsonSchema()],
  ['plugin-index.schema.json', pluginIndexJsonSchema()],
] as const) {
  const target = new URL(`../src/generated/${name}`, import.meta.url);
  writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote ${target.pathname}`);
}
