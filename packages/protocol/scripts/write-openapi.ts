// `pnpm openapi`: rewrites the companion's OpenAPI document from the zod route table.
// Run it after changing `companion.ts` or a schema it uses; `openapi.test.ts` fails until you do.
import { writeFileSync } from 'node:fs';
import { PROTOCOL_VERSION, companionOpenApi } from '../src/index';

const target = new URL('../src/generated/companion.openapi.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(companionOpenApi(PROTOCOL_VERSION), null, 2)}\n`);
console.log(`wrote ${target.pathname}`);
