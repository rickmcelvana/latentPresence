import { describe, expect, it } from 'vitest';
import { connectMcpServer, flattenCallResult } from './client';

/**
 * A streamable-HTTP MCP server in a `fetch`: JSON-RPC in, JSON out, the methods the adapter
 * uses. It drives the real `@ai-sdk/mcp` client, so a change in how that client speaks shows
 * up here rather than against a live server.
 */
function fakeServer(options: { readonly pages?: boolean } = {}) {
  const seen: { method: string; params: unknown; headers: Record<string, string> }[] = [];
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    const message = JSON.parse(String(init.body)) as { id?: number; method: string; params?: { cursor?: string; name?: string; arguments?: Record<string, unknown> } };
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    seen.push({ method: message.method, params: message.params, headers });
    if (message.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown): Response => new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    switch (message.method) {
      case 'initialize':
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Wiki', version: '1' }, instructions: 'Ask about repositories.' });
      case 'tools/list': {
        const first = { name: 'read_wiki', description: 'Read a wiki.', inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] }, annotations: { readOnlyHint: true } };
        const second = { name: 'ask', inputSchema: { type: 'object' } };
        if (options.pages === true) return message.params?.cursor === 'two' ? reply({ tools: [second] }) : reply({ tools: [first], nextCursor: 'two' });
        return reply({ tools: [first, second] });
      }
      case 'tools/call':
        return message.params?.name === 'read_wiki'
          ? reply({ content: [{ type: 'text', text: `Pages of ${String(message.params.arguments?.['repo'])}` }], isError: false })
          : reply({ content: [{ type: 'text', text: `Unknown tool: ${String(message.params?.name)}` }], isError: true });
      default:
        return reply({});
    }
  };
  return { fetch, seen };
}

async function down(): Promise<Response> {
  throw new TypeError('Failed to fetch');
}

describe('connectMcpServer (P5-T01, ADR-42)', () => {
  it('initialises, lists the tools with their schemas, and calls one', async () => {
    const server = fakeServer();
    const client = await connectMcpServer({ url: 'https://wiki.example/mcp', transport: 'http', headers: { Authorization: 'Bearer k' } }, { fetch: server.fetch });
    expect(client.serverName).toBe('Wiki');
    expect(client.instructions).toBe('Ask about repositories.');
    expect(await client.listTools()).toEqual([
      { name: 'read_wiki', description: 'Read a wiki.', inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] }, annotations: { readOnlyHint: true } },
      { name: 'ask', description: '', inputSchema: { type: 'object' }, annotations: null },
    ]);
    expect(await client.callTool('read_wiki', { repo: 'vercel/ai' })).toEqual({ isError: false, text: 'Pages of vercel/ai', structured: null, images: 0 });
    expect(server.seen.find((entry) => entry.method === 'tools/call')?.headers['authorization']).toBe('Bearer k');
    await client.close();
  });

  it('calls fetch as a plain function, as window.fetch requires ("Illegal invocation" otherwise)', async () => {
    const server = fakeServer();
    // Like `window.fetch`: refuses to run with any `this` but none (or the global).
    const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== undefined && this !== globalThis) return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"));
      return server.fetch(input, init);
    };
    const client = await connectMcpServer({ url: 'https://wiki.example/mcp', transport: 'http' }, { fetch: strict });
    expect((await client.listTools()).length).toBe(2);
  });

  it('passes a server’s own failure on as isError, not a throw', async () => {
    const client = await connectMcpServer({ url: 'https://wiki.example/mcp', transport: 'http' }, { fetch: fakeServer().fetch });
    expect(await client.callTool('nope', {})).toMatchObject({ isError: true, text: 'Unknown tool: nope' });
  });

  it('follows the pages of a long tool list', async () => {
    const client = await connectMcpServer({ url: 'https://wiki.example/mcp', transport: 'http' }, { fetch: fakeServer({ pages: true }).fetch });
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(['read_wiki', 'ask']);
  });

  it('throws when the server cannot be reached', async () => {
    await expect(connectMcpServer({ url: 'https://down.example/mcp', transport: 'http' }, { fetch: down })).rejects.toThrow();
  });
});

describe('flattenCallResult', () => {
  it('joins text, reads embedded resources and links, counts images and keeps structured content', () => {
    expect(
      flattenCallResult({
        content: [
          { type: 'text', text: 'One.' },
          { type: 'image', data: 'x', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///a', text: 'Two.' } },
          { type: 'resource_link', uri: 'https://example.com/b', name: 'b' },
        ],
        structuredContent: { answer: 42 },
      }),
    ).toEqual({ isError: false, text: 'One.\n\nTwo.\n\n(link: https://example.com/b)', structured: { answer: 42 }, images: 1 });
  });

  it('reads the older toolResult shape', () => {
    expect(flattenCallResult({ toolResult: { ok: 1 } })).toMatchObject({ text: '{"ok":1}' });
  });
});
