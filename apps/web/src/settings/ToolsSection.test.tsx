import { useState } from 'react';
import type { ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { toolFingerprint } from '@latentpresence/core';
import { FakeMcpServer, textResult } from '@latentpresence/providers/web';
import type { McpServerConfig } from '@latentpresence/providers/web';
import type { ConnectMcp } from '../chat/chat-tools';
import { InMemoryMasterKeyPort, Vault } from './vault';
import { mcpKeyRef, type ToolsSettings } from './settings';
import { ToolsSection } from './ToolsSection';

afterEach(cleanup);

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const SEARCH = { name: 'search', description: 'Search the wiki for a phrase.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: null };
const LONG = { name: 'read_all', description: 'Read everything. '.repeat(12), inputSchema: { type: 'object' }, annotations: null };

function fakeServer(): FakeMcpServer {
  return new FakeMcpServer('Wiki', [
    { info: SEARCH, run: () => textResult('found') },
    { info: LONG, run: () => textResult('all of it') },
  ]);
}

const EXISTING: ToolsSettings = {
  servers: [{ id: 'srv-1', label: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', transport: 'http', enabled: true, auth: 'bearer' }],
  grants: { 'srv-1': { search: { policy: 'auto', fingerprint: 'stale000' } }, other: { x: { policy: 'never', fingerprint: null } } },
};

interface Harness {
  readonly vault: Vault;
  readonly latest: () => ToolsSettings;
}

/** The section over real state, as the panel holds it: `latest()` is what would be saved. */
function mount(initial: ToolsSettings, connect?: ConnectMcp): Harness {
  const vault = new Vault(new InMemoryMasterKeyPort(), memoryStorage());
  let latest = initial;
  function Host(): ReactElement {
    const [tools, setTools] = useState(initial);
    return (
      <ToolsSection
        connect={connect}
        onChange={(update) =>
          setTools((previous) => {
            latest = update(previous);
            return latest;
          })
        }
        tools={tools}
        vault={vault}
      />
    );
  }
  render(<Host />);
  return { vault, latest: () => latest };
}

const EMPTY: ToolsSettings = { servers: [], grants: {} };

function fillForm(label: string, url: string): void {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: label } });
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: url } });
}

describe('ToolsSection — adding a server', () => {
  it('adds one, on, with its own id, and clears the form', () => {
    const { latest } = mount(EMPTY);
    fillForm('  DeepWiki ', ' https://mcp.deepwiki.com/mcp ');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    const [server] = latest().servers;
    expect(latest().servers).toHaveLength(1);
    expect(server).toMatchObject({ label: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', transport: 'http', enabled: true, auth: 'none' });
    expect(server?.id.length).toBeGreaterThan(8);
    expect(screen.getByText(/mcp.deepwiki.com\/mcp · Streamable HTTP/)).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });

  it('adds an SSE server', () => {
    const { latest } = mount(EMPTY);
    fillForm('Old', 'http://localhost:9000/sse');
    fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'sse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(latest().servers[0]).toMatchObject({ transport: 'sse', url: 'http://localhost:9000/sse' });
  });

  it('with a token, the token goes to the vault under the server id and never into settings', async () => {
    const { latest, vault } = mount(EMPTY);
    fillForm('Private', 'https://tools.example/mcp');
    fireEvent.change(screen.getByLabelText('Sign-in'), { target: { value: 'bearer' } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 's3cret-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Key saved');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

    const [server] = latest().servers;
    expect(server?.auth).toBe('bearer');
    expect(await vault.loadKey(mcpKeyRef(server?.id ?? ''))).toBe('s3cret-token');
    expect(JSON.stringify(latest())).not.toContain('s3cret-token');
    // The next server to add starts with no token showing.
    expect(screen.queryByText('Key saved')).toBeNull();
  });

  it('switching back to no sign-in forgets a token typed for the new server', async () => {
    mount(EMPTY);
    fireEvent.change(screen.getByLabelText('Sign-in'), { target: { value: 'bearer' } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Key saved');
    fireEvent.change(screen.getByLabelText('Sign-in'), { target: { value: 'none' } });
    fireEvent.change(screen.getByLabelText('Sign-in'), { target: { value: 'bearer' } });
    expect(screen.queryByText('Key saved')).toBeNull();
  });

  it('refuses an empty name, and an address that is not http(s), and says why', () => {
    const { latest } = mount(EMPTY);
    fillForm('', 'https://ok.example/mcp');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(screen.getByRole('alert').textContent).toContain('name');

    fillForm('Bad', 'ftp://ok.example/mcp');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(screen.getByRole('alert').textContent).toContain('http');

    fillForm('Bad', 'not a url');
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
    expect(latest().servers).toEqual([]);
  });
});

describe('ToolsSection — a listed server', () => {
  it('shows its label, address and connection, and the switch turns it off and on', () => {
    const { latest } = mount(EXISTING);
    expect(screen.getByText('DeepWiki')).toBeTruthy();
    expect(screen.getByText(/https:\/\/mcp.deepwiki.com\/mcp · Streamable HTTP/)).toBeTruthy();
    const toggle = screen.getByRole('switch') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(latest().servers[0]?.enabled).toBe(false);
    fireEvent.click(screen.getByRole('switch'));
    expect(latest().servers[0]?.enabled).toBe(true);
  });

  it('Remove asks first, and confirming drops the server, its grants and its token', async () => {
    const { latest, vault } = mount(EXISTING);
    await vault.saveKey(mcpKeyRef('srv-1'), 'tok');
    await vault.saveKey(mcpKeyRef('other'), 'keep');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(latest().servers).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(latest().servers).toHaveLength(1);
    expect(vault.hasKey(mcpKeyRef('srv-1'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(latest().servers).toEqual([]);
    expect(latest().grants).toEqual({ other: { x: { policy: 'never', fingerprint: null } } });
    expect(vault.hasKey(mcpKeyRef('srv-1'))).toBe(false);
    expect(vault.hasKey(mcpKeyRef('other'))).toBe(true);
    expect(screen.queryByText('DeepWiki')).toBeNull();
  });
});

describe('ToolsSection — Test', () => {
  const openServer: ToolsSettings = { servers: [{ ...EXISTING.servers[0]!, auth: 'none' }], grants: {} };

  it('connects, says how many tools, lists them, and closes the connection', async () => {
    const fake = fakeServer();
    const seen: McpServerConfig[] = [];
    mount(openServer, async (config) => {
      seen.push(config);
      return fake;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Connected — 2 tools')).toBeTruthy();
    expect(seen).toEqual([{ url: 'https://mcp.deepwiki.com/mcp', transport: 'http' }]);
    expect(screen.getByText('search')).toBeTruthy();
    expect(screen.getByText('Search the wiki for a phrase.')).toBeTruthy();
    expect(fake.calls).toEqual([]);
    await waitFor(() => expect(fake.closed).toBe(true));
  });

  it('sends the saved token as a bearer header', async () => {
    const seen: McpServerConfig[] = [];
    const { vault } = mount(EXISTING, async (config) => {
      seen.push(config);
      return fakeServer();
    });
    await vault.saveKey(mcpKeyRef('srv-1'), 'tok');
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Connected — 2 tools');
    expect(seen[0]?.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('a failing connection shows its message and lists no tools', async () => {
    mount(openServer, async () => {
      throw new TypeError('Failed to fetch');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Failed to fetch')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /Policy for/ })).toBeNull();
  });

  it('a server that needs a token and has none says so', async () => {
    mount(EXISTING, async () => fakeServer());
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('It needs a token, and none is saved.')).toBeTruthy();
  });

  it('each policy is stored as chosen, and only Always allow carries the fingerprint', async () => {
    const { latest } = mount(openServer, async () => fakeServer());
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const select = (await screen.findByRole('combobox', { name: 'Policy for search' })) as HTMLSelectElement;
    expect(select.value).toBe('ask');

    fireEvent.change(select, { target: { value: 'auto' } });
    expect(latest().grants['srv-1']?.['search']).toEqual({ policy: 'auto', fingerprint: toolFingerprint(SEARCH) });

    fireEvent.change(select, { target: { value: 'never' } });
    expect(latest().grants['srv-1']?.['search']).toEqual({ policy: 'never', fingerprint: null });

    fireEvent.change(select, { target: { value: 'ask' } });
    expect(latest().grants['srv-1']?.['search']).toEqual({ policy: 'ask', fingerprint: null });
    // The other tool was never touched.
    expect(latest().grants['srv-1']?.['read_all']).toBeUndefined();
  });

  it('a tool allowed before, and changed since, says she will ask again', async () => {
    const settings: ToolsSettings = {
      servers: openServer.servers,
      grants: { 'srv-1': { search: { policy: 'auto', fingerprint: 'stale000' }, read_all: { policy: 'auto', fingerprint: toolFingerprint(LONG) } } },
    };
    mount(settings, async () => fakeServer());
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Connected — 2 tools');
    expect(screen.getAllByText(/Changed since you allowed it/)).toHaveLength(1);
    expect((screen.getByRole('combobox', { name: 'Policy for search' }) as HTMLSelectElement).value).toBe('ask');
    expect((screen.getByRole('combobox', { name: 'Policy for read_all' }) as HTMLSelectElement).value).toBe('auto');
  });

  it('clamps a long description and expands it on request', async () => {
    mount(openServer, async () => fakeServer());
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Connected — 2 tools');
    const row = screen.getByText('read_all').closest('li') as HTMLElement;
    const description = row.querySelector('.tools-tool-description') as HTMLElement;
    expect(description.className).toContain('tools-tool-description-clamped');
    fireEvent.click(within(row).getByRole('button', { name: 'Show more' }));
    expect(description.className).not.toContain('clamped');
    fireEvent.click(within(row).getByRole('button', { name: 'Show less' }));
    expect(description.className).toContain('clamped');
    // A short description needs no toggle.
    expect(within(screen.getByText('search').closest('li') as HTMLElement).queryByRole('button')).toBeNull();
  });
});
