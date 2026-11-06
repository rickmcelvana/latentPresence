// `pnpm plugin:schema`: rewrites the JSON Schema for `plugin.json` from the zod manifest (ADR-72).
// Run it after changing `plugin.ts`; `plugin.test.ts` fails until you do.
import { writeFileSync } from 'node:fs';
import { pluginManifestJsonSchema } from '../src/index';

const target = new URL('../src/generated/plugin.schema.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(pluginManifestJsonSchema(), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
