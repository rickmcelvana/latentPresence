import { z } from 'zod';
import { CompanionErrorSchema, companionRoutes, type CompanionRoute } from './companion';

/**
 * The companion's HTTP contract as OpenAPI 3.1, generated from `companionRoutes` (P4-T02).
 *
 * The zod table is the source; this document is how the Rust side reads it. It is committed
 * as `generated/companion.openapi.json` — a test fails when the two drift, and `pnpm openapi`
 * rewrites it — and the companion's tests validate every response they get against the
 * schema here, so "the Rust router matches the zod schema" is checked in both languages
 * rather than asserted in one.
 *
 * Each component is a standalone JSON Schema (2020-12): a recursive type such as a tool's
 * JSON arguments keeps its own `$defs`, so a component can be compiled on its own by a
 * validator without the rest of the document.
 */

type JsonSchema = Record<string, unknown>;

function schemaOf(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io, cycles: 'ref', reused: 'inline', unrepresentable: 'any' }) as JsonSchema;
  return rest;
}

function capitalised(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Path and query parameters, one per property of their object schema. */
function parameters(route: CompanionRoute): JsonSchema[] {
  const out: JsonSchema[] = [];
  for (const [where, schema] of [
    ['path', route.params],
    ['query', route.query],
  ] as const) {
    if (schema === null) continue;
    const json = schemaOf(schema, 'input');
    const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((json.required ?? []) as string[]);
    for (const [name, property] of Object.entries(properties)) {
      out.push({ name, in: where, required: where === 'path' || required.has(name), schema: property });
    }
  }
  return out;
}

/** `version` is `PROTOCOL_VERSION`, passed in because `index.ts` defines it and re-exports this module. */
export function companionOpenApi(version: number): JsonSchema {
  const schemas: Record<string, JsonSchema> = { CompanionError: schemaOf(CompanionErrorSchema, 'output') };
  const paths: Record<string, Record<string, JsonSchema>> = {};
  const error = { description: 'Every failure, one shape', content: { 'application/json': { schema: { $ref: '#/components/schemas/CompanionError' } } } };

  for (const [name, route] of Object.entries(companionRoutes) as [string, CompanionRoute][]) {
    const path = route.path.replaceAll(/:(\w+)/g, '{$1}');
    const responseName = `${capitalised(name)}Response`;
    schemas[responseName] = schemaOf(route.response, 'output');
    const operation: JsonSchema = {
      operationId: name,
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { $ref: `#/components/schemas/${responseName}` } } } },
        default: error,
      },
    };
    const params = parameters(route);
    if (params.length > 0) operation.parameters = params;
    if (route.request !== null) {
      const requestName = `${capitalised(name)}Request`;
      schemas[requestName] = schemaOf(route.request, 'input');
      operation.requestBody = { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${requestName}` } } } };
    }
    paths[path] = { ...paths[path], [route.method.toLowerCase()]: operation };
  }

  return {
    openapi: '3.1.0',
    info: { title: 'latentPresence companion', version: String(version), license: { name: 'Apache-2.0', identifier: 'Apache-2.0' } },
    paths,
    components: { schemas },
  };
}
