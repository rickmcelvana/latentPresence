import { FakeMcpServer, textResult } from '@latentpresence/providers/web';
import type { McpServerConfig } from '@latentpresence/providers/web';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, loadSettings, type ToolServerSetting } from '../settings/settings';
import { connectToolServers, settingsToolGrants } from './chat-tools';

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

describe('settingsToolGrants', () => {
  it('reads and writes the settings document each time, keeping everything else', () => {
    const storage = memoryStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_SETTINGS, tools: { servers: [WIKI], grants: {} } }) });
    const grants = settingsToolGrants(storage);
    expect(grants.get('srv-1', 'read')).toBeUndefined();
    grants.set('srv-1', 'read', { policy: 'auto', fingerprint: 'abcd1234' });
    grants.set('srv-1', 'write', { policy: 'never', fingerprint: null });
    expect(grants.get('srv-1', 'read')).toEqual({ policy: 'auto', fingerprint: 'abcd1234' });
    expect(loadSettings(storage).tools).toEqual({ servers: [WIKI], grants: { 'srv-1': { read: { policy: 'auto', fingerprint: 'abcd1234' }, write: { policy: 'never', fingerprint: null } } } });
  });
});
