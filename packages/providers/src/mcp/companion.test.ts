import type { McpToolsResponse } from '@latentpresence/protocol';
import { describe, expect, it } from 'vitest';
import { companionToolServers } from './companion';

const LISTED: McpToolsResponse = {
  servers: [
    { id: 'files', label: 'Files', kind: 'files', state: 'ready', detail: null, instructions: 'Read-only, inside the roots.' },
    { id: 'everything', label: 'everything', kind: 'stdio', state: 'failed', detail: 'it exited: npx: not found', instructions: null },
  ],
  tools: [{ serverId: 'files', name: 'read_text_file', description: 'Read a text file.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
};

/** A companion in a `fetch`: `/mcp/tools` answers `listed`, `/mcp/call` answers `call(body)`. */
function companion(listed: unknown = LISTED, call: (body: Record<string, unknown>) => Response = () => Response.json({ isError: false, text: 'hello', structured: null, images: 0 })) {
  const seen: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body === undefined ? null : (JSON.parse(String(init.body)) as Record<string, unknown>);
    seen.push({ url, method: init?.method ?? 'GET', body });
    return url.endsWith('/mcp/tools') ? Response.json(listed) : call(body ?? {});
  };
  return { fetch, seen };
}

async function down(): Promise<Response> {
  throw new TypeError('Failed to fetch');
}

describe('companionToolServers (P5-T02, ADR-43)', () => {
  it('lists every server with its state, and gives a client only to the ready ones', async () => {
    const { fetch, seen } = companion();
    const servers = await companionToolServers({ baseUrl: 'http://127.0.0.1:8787/', fetch });
    expect(seen[0]).toEqual({ url: 'http://127.0.0.1:8787/mcp/tools', method: 'GET', body: null });
    expect(servers.map(({ server, tools, client }) => [server.id, server.state, tools.length, client === null])).toEqual([
      ['files', 'ready', 1, false],
      ['everything', 'failed', 0, true],
    ]);
    const files = servers[0]?.client;
    expect(files?.serverName).toBe('Files');
    expect(files?.instructions).toBe('Read-only, inside the roots.');
    expect(await files?.listTools()).toEqual([{ name: 'read_text_file', description: 'Read a text file.', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]);
  });

  it('calls a tool through /mcp/call, naming its server', async () => {
    const { fetch, seen } = companion();
    const [files] = await companionToolServers({ baseUrl: 'http://127.0.0.1:8787', fetch });
    expect(await files?.client?.callTool('read_text_file', { path: 'notes.md' })).toEqual({ isError: false, text: 'hello', structured: null, images: 0 });
    expect(seen[1]).toEqual({
      url: 'http://127.0.0.1:8787/mcp/call',
      method: 'POST',
      body: { callId: expect.any(String), serverId: 'files', name: 'read_text_file', arguments: { path: 'notes.md' } },
    });
  });

  it('throws the companion’s own words when a call fails, and when it is not answering', async () => {
    const error = Response.json({ error: { code: 'unavailable', message: 'everything is still starting', details: null } }, { status: 503 });
    const { fetch } = companion(LISTED, () => error);
    const [files] = await companionToolServers({ baseUrl: 'http://127.0.0.1:8787', fetch });
    await expect(files?.client?.callTool('read_text_file', {})).rejects.toThrow('everything is still starting');
    await expect(companionToolServers({ baseUrl: 'http://127.0.0.1:8787', fetch: down })).rejects.toThrow('the companion is not answering (Failed to fetch)');
  });

  it('refuses an answer in another shape — an older companion, say', async () => {
    const { fetch } = companion({ tools: [] });
    await expect(companionToolServers({ baseUrl: 'http://127.0.0.1:8787', fetch })).rejects.toThrow(/different version/u);
  });
});
