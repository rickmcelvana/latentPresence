import { FakeMcpServer, textResult } from '@latentpresence/providers/web';
import type { CompanionToolServer, McpServerConfig } from '@latentpresence/providers/web';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, loadSettings, type ToolServerSetting } from '../settings/settings';
import { connectCompanionTools, connectToolServers, settingsToolGrants } from './chat-tools';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value) };
}

const WIKI: ToolServerSetting = { id: 'srv-1', label: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', transport: 'http', enabled: true, auth: 'none' };
const TOOL = { info: { name: 'read', description: 'Read.', inputSchema: { type: 'object' }, annotations: null }, run: () => textResult('ok') };

describe('connectToolServers (P5-T01, ADR-42)', () => {
  it('connects the enabled servers, with the bearer token from the vault, and says how each went', async () => {
    const seen: McpServerConfig[] = [];
    const result = await connectToolServers({
      servers: [WIKI, { ...WIKI, id: 'srv-2', label: 'Private', auth: 'bearer' }, { ...WIKI, id: 'srv-3', label: 'Off', enabled: false }],
      loadKey: async (ref) => (ref === 'mcp:srv-2' ? 'secret' : null),
      connect: async (config) => {
        seen.push(config);
        return new FakeMcpServer('x', [TOOL]);
      },
    });
    expect(seen).toEqual([
      { url: WIKI.url, transport: 'http' },
      { url: WIKI.url, transport: 'http', headers: { Authorization: 'Bearer secret' } },
    ]);
    expect(result.connected.map((server) => [server.id, server.label, server.tools.map((tool) => tool.name)])).toEqual([
      ['srv-1', 'DeepWiki', ['read']],
      ['srv-2', 'Private', ['read']],
    ]);
    expect(result.statuses).toEqual([
      { id: 'srv-1', label: 'DeepWiki', ok: true, detail: '1 tool' },
      { id: 'srv-2', label: 'Private', ok: true, detail: '1 tool' },
    ]);
  });

  it('reports a server it cannot reach, or one missing its token, and connects the rest', async () => {
    const result = await connectToolServers({
      servers: [WIKI, { ...WIKI, id: 'down', label: 'Down', url: 'https://down.example/mcp' }, { ...WIKI, id: 'locked', label: 'Locked', auth: 'bearer' }],
      loadKey: async () => null,
      connect: async (config) => {
        if (config.url.includes('down.example')) throw new TypeError('Failed to fetch');
        return new FakeMcpServer('x', [TOOL]);
      },
    });
    expect(result.connected.map((server) => server.id)).toEqual(['srv-1']);
    expect(result.statuses).toEqual([
      { id: 'srv-1', label: 'DeepWiki', ok: true, detail: '1 tool' },
      { id: 'down', label: 'Down', ok: false, detail: 'Failed to fetch' },
      { id: 'locked', label: 'Locked', ok: false, detail: 'It needs a token, and none is saved.' },
    ]);
  });
});

describe('the companion’s servers (P5-T02, ADR-43)', () => {
  const files = new FakeMcpServer('Files', [TOOL]);
  const listed: CompanionToolServer[] = [
    { server: { id: 'files', label: 'Files', kind: 'files', state: 'ready', detail: null, instructions: null }, tools: [TOOL.info], client: files },
    { server: { id: 'everything', label: 'everything', kind: 'stdio', state: 'failed', detail: 'it exited: npx: not found', instructions: null }, tools: [], client: null },
    { server: { id: 'slow', label: 'slow', kind: 'stdio', state: 'starting', detail: null, instructions: null }, tools: [], client: null },
  ];

  it('joins the ready ones under companion:<name>, and says why each other one is not there', async () => {
    const asked: string[] = [];
    const result = await connectToolServers({
      servers: [WIKI],
      loadKey: async () => null,
      connect: async () => new FakeMcpServer('x', [TOOL]),
      companion: { baseUrl: 'http://127.0.0.1:8787' },
      listCompanion: async ({ baseUrl }) => {
        asked.push(baseUrl);
        return listed;
      },
    });
    expect(asked).toEqual(['http://127.0.0.1:8787']);
    expect(result.connected.map((server) => [server.id, server.label])).toEqual([
      ['srv-1', 'DeepWiki'],
      ['companion:files', 'Files'],
    ]);
    expect(result.connected[1]?.client).toBe(files);
    expect(result.statuses.slice(1)).toEqual([
      { id: 'companion:files', label: 'Files', ok: true, detail: '1 tool' },
      { id: 'companion:everything', label: 'everything', ok: false, detail: 'it exited: npx: not found' },
      { id: 'companion:slow', label: 'slow', ok: false, detail: 'it is still starting; reload in a moment' },
    ]);
  });

  it('asks the companion nothing unless they are turned on, and says how to start it when it is down', async () => {
    let asked = 0;
    const listCompanion = async (): Promise<CompanionToolServer[]> => {
      asked += 1;
      throw new Error('the companion is not answering (Failed to fetch)');
    };
    await connectToolServers({ servers: [], loadKey: async () => null, companion: null, listCompanion });
    expect(asked).toBe(0);
    const down = await connectCompanionTools({ baseUrl: 'http://127.0.0.1:8787', listCompanion });
    expect(down).toEqual({
      connected: [],
      statuses: [{ id: 'companion:', label: 'The companion', ok: false, detail: 'the companion is not answering (Failed to fetch); start it with "pnpm companion", then reload' }],
    });
  });
});

describe('settingsToolGrants', () => {
  it('reads and writes the settings document each time, keeping everything else', () => {
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, tools: { servers: [WIKI], grants: {} } }) });
    const grants = settingsToolGrants(storage);
    expect(grants.get('srv-1', 'read')).toBeUndefined();
    grants.set('srv-1', 'read', { policy: 'auto', fingerprint: 'abcd1234' });
    grants.set('srv-1', 'write', { policy: 'never', fingerprint: null });
    expect(grants.get('srv-1', 'read')).toEqual({ policy: 'auto', fingerprint: 'abcd1234' });
    expect(loadSettings(storage).tools).toEqual({ servers: [WIKI], grants: { 'srv-1': { read: { policy: 'auto', fingerprint: 'abcd1234' }, write: { policy: 'never', fingerprint: null } } }, companion: false });
  });
});
