import { z } from 'zod';
import { JsonObjectSchema, JsonValueSchema, type JsonObject } from '../common';
import type { CancellationSignal } from './shared';

/**
 * An MCP server the page talks to (P5-T01, ADR-42): what it offers and how to call it.
 *
 * Deliberately smaller than MCP: tools only — no resources, prompts or sampling yet — because
 * tools are what the character uses. The adapter (`@ai-sdk/mcp` in `providers`) speaks the
 * protocol; the gate, the naming and the result the model reads are core's.
 */

/** How the page reaches a server. `stdio` is not here on purpose: only the companion starts processes (ADR-42). */
export const McpTransportSchema = z.enum(['http', 'sse']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

/** The hints a server may give about a tool. Hints, not promises — the gate never trusts them. */
export const McpToolAnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});

/** A tool as the server listed it. `inputSchema` is JSON Schema, unchanged. */
export const McpToolInfoSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: JsonObjectSchema,
  annotations: McpToolAnnotationsSchema.nullable(),
});
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>;

/**
 * What a call returned, flattened: its text content joined, its structured content if any, and
 * how many images it carried (named to the model, never sent). A server's own failure is
 * `isError`, a normal outcome; only a broken connection throws.
 */
export const McpCallResultSchema = z.object({
  isError: z.boolean(),
  text: z.string(),
  structured: JsonValueSchema.nullable(),
  images: z.number().int().min(0),
});
export type McpCallResult = z.infer<typeof McpCallResultSchema>;

export interface McpRequestOptions {
  readonly signal?: CancellationSignal | undefined;
}

export interface McpServerClient {
  /** The server's own name for itself (`serverInfo.name`), or the URL's host. */
  readonly serverName: string;
  /** What the server says about how to use it, if anything. */
  readonly instructions: string | null;
  listTools(options?: McpRequestOptions): Promise<McpToolInfo[]>;
  callTool(name: string, args: JsonObject, options?: McpRequestOptions): Promise<McpCallResult>;
  close(): Promise<void>;
}
