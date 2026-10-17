import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConsent } from '@latentpresence/ml-web/consent';
import type { CompanionToolServer, EndpointProbe, HttpFetch } from '@latentpresence/providers/web';
import type { MinimalCacheStorage } from '../consent/deps';
import { emptyCompanionConfig, FakeCompanionConfig } from '../desktop/companion-config.fake';
import { initDesktop, resetDesktopForTests, type Invoke } from '../desktop/desktop';
import { useCompanionConfig } from './companion-config-state';
import { CompanionSettings } from './CompanionSettings';
import type { SettingsDeps } from './deps';
import { SettingsPanel } from './SettingsPanel';
import { loadSettings } from './settings';
import { InMemoryMasterKeyPort, Vault } from './vault';

afterEach(() => {
  cleanup();
  resetDesktopForTests();
});

const URL_HA = 'http://homeassistant.local:8123';

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

function testDeps(): SettingsDeps {
  const caches: MinimalCacheStorage = { keys: async () => [], open: () => Promise.reject(new Error('no cache')), delete: async () => false };
  return {
    vault: new Vault(new InMemoryMasterKeyPort(), memoryStorage()),
    storage: memoryStorage(),
    fetch: (async () => new Response('{}', { status: 200 })) as HttpFetch,
    probe: async (): Promise<EndpointProbe> => ({ kind: 'answered', status: 200 }),
    origin: 'http://localhost:5173',
    now: () => Date.now(),
    createAudioContext: () => {
      throw new Error('not used in these tests');
    },
    consent: new ModelConsent(memoryStorage()),
    caches,
  };
}

function homeServer(state: 'starting' | 'ready' | 'failed', detail: string | null = null): CompanionToolServer {
  return {
    server: { id: 'homeassistant', label: 'Home Assistant', kind: 'homeassistant', state, detail, instructions: null },
    tools: [],
    client: null,
  };
}

interface HarnessProps {
  readonly api: FakeCompanionConfig;
  readonly tools?: boolean;
  readonly search?: boolean;
  readonly list?: () => Promise<CompanionToolServer[]>;
}

/** The controller over a fake shell, with the two switches kept in state and printed. */
function Harness({ api, tools = false, search = false, list = async () => [homeServer('ready')] }: HarnessProps) {
  const [on, setOn] = useState({ tools, search });
  const controller = useCompanionConfig({
    api,
    switches: { ...on, turnOn: (which) => setOn((previous) => ({ ...previous, [which]: true })) },
    companionUrl: 'http://127.0.0.1:8790',
    fetch: (async () => new Response('{}')) as HttpFetch,
    listCompanion: list,
    waitMs: 200,
    pollMs: 1,
  });
  return (
    <>
      <CompanionSettings controller={controller} />
      <output aria-label="switches">{`tools=${String(on.tools)} search=${String(on.search)}`}</output>
    </>
  );
}

function panel(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

async function loaded(api: FakeCompanionConfig, props: Omit<HarnessProps, 'api'> = {}): Promise<void> {
  render(<Harness api={api} {...props} />);
  await screen.findByRole('region', { name: 'Home Assistant' });
}

const switches = (): string => screen.getByLabelText('switches').textContent ?? '';

describe('Settings → On this computer (P8-T06)', () => {
  it('looks, then shows every section with the note about restarting', async () => {
    const api = new FakeCompanionConfig();
    render(<Harness api={api} />);
    expect(screen.getByText('Looking…')).toBeTruthy();
    await screen.findByRole('region', { name: 'Home Assistant' });
    for (const name of ['Folders she may read', 'Documents she can search', 'Web search', 'Databases she may query', 'Programs']) {
      expect(panel(name)).toBeTruthy();
    }
    expect(screen.getByRole('heading', { name: 'On this computer' })).toBeTruthy();
    expect(screen.getByText(/Changes restart the companion; her tools from it are back in a few seconds/)).toBeTruthy();
    expect(api.reads).toBe(1);
  });

  it('a read that fails shows its sentence and Retry reads again', async () => {
    const api = new FakeCompanionConfig();
    api.readFails = 'The companion is not running.';
    render(<Harness api={api} />);
    expect(await screen.findByText('The companion is not running.')).toBeTruthy();
    api.readFails = null;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('region', { name: 'Home Assistant' });
    expect(api.reads).toBe(2);
  });

  it('shows secrets only as where they are, never their text', async () => {
    const api = new FakeCompanionConfig(
      emptyCompanionConfig({
        home: { url: URL_HA, token: 'stored', problem: null },
        web: { provider: 'tavily', url: null, key: 'inFile', readPages: true, problem: null },
        databases: [
          { name: 'recipes', description: 'My recipes', address: 'postgres://me@db.local:5432/recipes', path: null, secret: 'stored', disabled: false, problem: null },
          { name: 'notes', description: null, address: null, path: 'C:\\data\\notes.sqlite', secret: 'missing', disabled: true, problem: null },
        ],
      }),
    );
    const { container } = render(<Harness api={api} />);
    await screen.findByRole('region', { name: 'Home Assistant' });

    const home = within(panel('Home Assistant'));
    expect((home.getByLabelText('Home Assistant address') as HTMLInputElement).value).toBe(URL_HA);
    expect(home.getByText('Saved in Credential Manager')).toBeTruthy();
    expect(home.queryByLabelText('Access token')).toBeNull();
    expect(home.getByRole('button', { name: 'Replace' })).toBeTruthy();

    const web = within(panel('Web search'));
    expect(web.getByText('In mcp.json, in plain text')).toBeTruthy();
    expect(web.getByText(/moves it to Windows Credential Manager/)).toBeTruthy();
    expect((web.getByLabelText('She may also read web pages') as HTMLInputElement).checked).toBe(true);

    const databases = within(panel('Databases she may query'));
    expect(databases.getByText('postgres://me@db.local:5432/recipes')).toBeTruthy();
    expect(databases.getByText('C:\\data\\notes.sqlite')).toBeTruthy();
    expect(databases.getByText('off')).toBeTruthy();
    expect(container.querySelectorAll('input[type="password"]').length).toBe(1); // only the new database's address
  });

  it('Home Assistant: Save sends the token only when one was typed', async () => {
    const api = new FakeCompanionConfig(emptyCompanionConfig({ home: { url: URL_HA, token: 'stored', problem: null } }));
    await loaded(api);
    const home = within(panel('Home Assistant'));

    fireEvent.change(home.getByLabelText('Home Assistant address'), { target: { value: 'http://192.168.1.5:8123' } });
    fireEvent.click(home.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.changes).toHaveLength(1));
    expect(api.changes[0]).toStrictEqual({ kind: 'home', url: 'http://192.168.1.5:8123' });

    await waitFor(() => expect(home.getByText('Connected')).toBeTruthy());
    fireEvent.click(home.getByRole('button', { name: 'Replace' }));
    const token = home.getByLabelText('Access token') as HTMLInputElement;
    expect(token.type).toBe('password');
    fireEvent.change(token, { target: { value: 'eyJ-long-lived' } });
    fireEvent.click(home.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.changes).toHaveLength(2));
    expect(api.changes[1]).toStrictEqual({ kind: 'home', url: 'http://192.168.1.5:8123', token: 'eyJ-long-lived' });
  });

  it('a refusal shows the companion\'s own sentence in the panel that caused it', async () => {
    const api = new FakeCompanionConfig();
    await loaded(api);
    api.rejectNext = 'Home Assistant: "homeassistant.local" is not an http(s) address, like http://homeassistant.local:8123';
    const home = within(panel('Home Assistant'));
    fireEvent.change(home.getByLabelText('Home Assistant address'), { target: { value: 'homeassistant.local' } });
    fireEvent.change(home.getByLabelText('Access token'), { target: { value: 'tok' } });
    fireEvent.click(home.getByRole('button', { name: 'Save' }));
    expect(await home.findByText(/is not an http\(s\) address/)).toBeTruthy();
    expect(within(panel('Web search')).queryByText(/is not an http\(s\) address/)).toBeNull();
    expect(switches()).toBe('tools=false search=false');
    // The view is unchanged: the form keeps what was typed.
    expect((home.getByLabelText('Home Assistant address') as HTMLInputElement).value).toBe('homeassistant.local');
  });

  it('says whether Home Assistant came up: ready after starting, or why it failed', async () => {
    const api = new FakeCompanionConfig();
    let asks = 0;
    await loaded(api, {
      list: async () => {
        asks += 1;
        if (asks === 1) throw new Error('the companion is not answering');
        return [homeServer(asks === 2 ? 'starting' : 'ready')];
      },
    });
    const home = within(panel('Home Assistant'));
    fireEvent.change(home.getByLabelText('Home Assistant address'), { target: { value: URL_HA } });
    fireEvent.change(home.getByLabelText('Access token'), { target: { value: 'tok' } });
    fireEvent.click(home.getByRole('button', { name: 'Save' }));
    expect(await home.findByText('Connected')).toBeTruthy();
    expect(asks).toBe(3);
    cleanup();

    const failing = new FakeCompanionConfig();
    await loaded(failing, { list: async () => [homeServer('failed', 'Home Assistant refused the token (401).')] });
    const again = within(panel('Home Assistant'));
    fireEvent.change(again.getByLabelText('Home Assistant address'), { target: { value: URL_HA } });
    fireEvent.change(again.getByLabelText('Access token'), { target: { value: 'bad' } });
    fireEvent.click(again.getByRole('button', { name: 'Save' }));
    const line = await again.findByText('Home Assistant refused the token (401).');
    expect(line.className).toContain('settings-status-danger');
  });

  it('Remove sends its change, for Home Assistant, a folder, a document folder, a database and web search', async () => {
    const api = new FakeCompanionConfig(
      emptyCompanionConfig({
        home: { url: URL_HA, token: 'stored', problem: null },
        roots: ['C:\\Notes'],
        folders: ['C:\\Manuals'],
        web: { provider: 'searxng', url: 'http://127.0.0.1:8080', key: 'missing', readPages: false, problem: null },
        databases: [{ name: 'recipes', description: null, address: 'postgres://me@db/x', path: null, secret: 'stored', disabled: false, problem: null }],
        embedding: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'nomic-embed-text', dimensions: 768, documentPrefix: 'a ', queryPrefix: 'b ' },
      }),
    );
    await loaded(api);
    fireEvent.click(within(panel('Folders she may read')).getByRole('button', { name: 'Remove C:\\Notes' }));
    await waitFor(() => expect(api.config.roots).toEqual([]));
    fireEvent.click(within(panel('Documents she can search')).getByRole('button', { name: 'Remove C:\\Manuals' }));
    await waitFor(() => expect(api.config.folders).toEqual([]));
    fireEvent.click(within(panel('Documents she can search')).getByRole('button', { name: 'Remove the embedding model' }));
    await waitFor(() => expect(api.config.embedding).toBeNull());
    fireEvent.click(within(panel('Databases she may query')).getByRole('button', { name: 'Remove recipes' }));
    await waitFor(() => expect(api.config.databases).toEqual([]));
    fireEvent.click(within(panel('Web search')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.config.web).toBeNull());
    fireEvent.click(within(panel('Home Assistant')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.config.home).toBeNull());

    expect(api.changes.map((change) => change.kind)).toEqual(['removeRoot', 'removeDocumentsFolder', 'embedding', 'removeDatabase', 'removeWeb', 'removeHome']);
    expect(api.changes[0]).toStrictEqual({ kind: 'removeRoot', path: 'C:\\Notes' });
    expect(api.changes[1]).toStrictEqual({ kind: 'removeDocumentsFolder', path: 'C:\\Manuals' });
    expect(api.changes[2]).toStrictEqual({ kind: 'embedding', embedding: null });
    // Removing never turns a switch on.
    expect(switches()).toBe('tools=false search=false');
  });

  it('Add a folder opens the system dialog: the pick is shown, and a cancel changes nothing', async () => {
    const api = new FakeCompanionConfig();
    await loaded(api);
    const files = within(panel('Folders she may read'));

    fireEvent.click(files.getByRole('button', { name: 'Add a folder…' }));
    await waitFor(() => expect(api.picks).toEqual(['files']));
    await waitFor(() => expect((files.getByRole('button', { name: 'Add a folder…' }) as HTMLButtonElement).disabled).toBe(false));
    expect(api.config.roots).toEqual([]);
    expect(files.getByText('No folders yet.')).toBeTruthy();
    expect(switches()).toBe('tools=false search=false');
    expect(files.queryByText(/Turned on/)).toBeNull();

    api.nextFolder = 'C:\\Notes';
    fireEvent.click(files.getByRole('button', { name: 'Add a folder…' }));
    expect(await files.findByText('C:\\Notes')).toBeTruthy();
    expect(files.getByText(/Turned on "Offer the companion.s tools"/)).toBeTruthy();
    expect(switches()).toBe('tools=true search=false');
    expect(api.changes).toEqual([]); // the page never names a folder
  });

  it('adding a documents folder turns on her document search, and Files / databases / web turn on the tools', async () => {
    const api = new FakeCompanionConfig();
    await loaded(api);
    api.nextFolder = 'C:\\Manuals';
    const documents = within(panel('Documents she can search'));
    fireEvent.click(documents.getByRole('button', { name: 'Add a folder…' }));
    expect(await documents.findByText('C:\\Manuals')).toBeTruthy();
    expect(documents.getByText(/Turned on her search of documents/)).toBeTruthy();
    expect(switches()).toBe('tools=false search=true');

    const web = within(panel('Web search'));
    fireEvent.change(web.getByLabelText('Search provider'), { target: { value: 'searxng' } });
    fireEvent.change(web.getByLabelText('SearXNG address'), { target: { value: 'http://127.0.0.1:8080' } });
    fireEvent.click(web.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(switches()).toBe('tools=true search=true'));
  });

  it('never turns a switch off, and says nothing when it is already on', async () => {
    const api = new FakeCompanionConfig(emptyCompanionConfig({ roots: ['C:\\Notes'] }));
    await loaded(api, { tools: true, search: true });
    api.nextFolder = 'C:\\More';
    const files = within(panel('Folders she may read'));
    fireEvent.click(files.getByRole('button', { name: 'Add a folder…' }));
    await files.findByText('C:\\More');
    fireEvent.click(files.getByRole('button', { name: 'Remove C:\\Notes' }));
    await waitFor(() => expect(files.queryByText('C:\\Notes')).toBeNull());
    expect(switches()).toBe('tools=true search=true');
    expect(files.queryByText(/Turned on/)).toBeNull();
  });

  it('disables every button while a change is in flight', async () => {
    const api = new FakeCompanionConfig(emptyCompanionConfig({ roots: ['C:\\Notes'] }));
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = api.change.bind(api);
    api.change = async (change) => {
      await held;
      return original(change);
    };
    await loaded(api);
    fireEvent.click(within(panel('Folders she may read')).getByRole('button', { name: 'Remove C:\\Notes' }));
    await waitFor(() => expect((within(panel('Web search')).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(panel('Folders she may read')).getByRole('button', { name: 'Add a folder…' }) as HTMLButtonElement).disabled).toBe(true);
    release?.();
    await waitFor(() => expect((within(panel('Folders she may read')).getByRole('button', { name: 'Add a folder…' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('fills the Ollama embedding model for the person to Save, and sends it', async () => {
    const api = new FakeCompanionConfig();
    await loaded(api);
    const documents = within(panel('Documents she can search'));
    expect(documents.getByText(/Keyword search only/)).toBeTruthy();

    fireEvent.click(documents.getByRole('button', { name: "Use Ollama's nomic-embed-text" }));
    expect((documents.getByLabelText('Embedding model address') as HTMLInputElement).value).toBe('http://127.0.0.1:11434/v1');
    expect((documents.getByLabelText('Model') as HTMLInputElement).value).toBe('nomic-embed-text');
    expect((documents.getByLabelText('Dimensions') as HTMLInputElement).value).toBe('768');
    expect((documents.getByLabelText('Document prefix') as HTMLInputElement).value).toBe('search_document: ');
    expect((documents.getByLabelText('Query prefix') as HTMLInputElement).value).toBe('search_query: ');
    expect(api.changes).toEqual([]); // a suggestion until Save

    fireEvent.click(documents.getByRole('button', { name: 'Save the embedding model' }));
    await waitFor(() => expect(api.changes).toHaveLength(1));
    expect(api.changes[0]).toStrictEqual({
      kind: 'embedding',
      embedding: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'nomic-embed-text', dimensions: 768, documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' },
    });
  });

  it('refuses dimensions that are not a whole number before asking the companion', async () => {
    const api = new FakeCompanionConfig();
    await loaded(api);
    const documents = within(panel('Documents she can search'));
    fireEvent.click(documents.getByRole('button', { name: "Use Ollama's nomic-embed-text" }));
    fireEvent.change(documents.getByLabelText('Dimensions'), { target: { value: 'lots' } });
    fireEvent.click(documents.getByRole('button', { name: 'Save the embedding model' }));
    expect(await documents.findByText(/whole number/)).toBeTruthy();
    expect(api.changes).toEqual([]);
  });

  it('web search: a key only when typed, the SearXNG address, and read pages', async () => {
    const api = new FakeCompanionConfig(emptyCompanionConfig({ web: { provider: 'brave', url: null, key: 'stored', readPages: false, problem: 'Brave refused the key.' } }));
    await loaded(api);
    const web = within(panel('Web search'));
    expect(web.getByText('Brave refused the key.')).toBeTruthy();
    expect(web.getByText('Saved in Credential Manager')).toBeTruthy();
    fireEvent.click(web.getByLabelText('She may also read web pages'));
    fireEvent.click(web.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.changes).toHaveLength(1));
    expect(api.changes[0]).toStrictEqual({ kind: 'web', provider: 'brave', readPages: true });

    // Another provider has no key saved for it.
    fireEvent.change(web.getByLabelText('Search provider'), { target: { value: 'tavily' } });
    fireEvent.change(web.getByLabelText('Tavily API key'), { target: { value: 'tvly-123' } });
    fireEvent.click(web.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.changes).toHaveLength(2));
    expect(api.changes[1]).toStrictEqual({ kind: 'web', provider: 'tavily', key: 'tvly-123', readPages: true });
  });

  it('databases: adds one by address, checks the name, and a SQLite file goes through the system dialog', async () => {
    const api = new FakeCompanionConfig();
    await loaded(api);
    const databases = within(panel('Databases she may query'));
    const address = databases.getByLabelText('Address') as HTMLInputElement;
    expect(address.type).toBe('password');

    fireEvent.change(databases.getByLabelText('Name'), { target: { value: 'my recipes' } });
    fireEvent.change(address, { target: { value: 'postgres://me:s3cret@db.local:5432/recipes' } });
    fireEvent.click(databases.getByRole('button', { name: 'Add the database' }));
    expect(await databases.findByText('A name is letters, digits, - and _ only.')).toBeTruthy();
    expect(api.changes).toEqual([]);

    fireEvent.change(databases.getByLabelText('Name'), { target: { value: 'recipes' } });
    fireEvent.change(databases.getByLabelText('What is in it (optional)'), { target: { value: 'My recipes' } });
    fireEvent.click(databases.getByRole('button', { name: 'Add the database' }));
    await waitFor(() => expect(api.changes).toHaveLength(1));
    expect(api.changes[0]).toStrictEqual({ kind: 'addDatabase', name: 'recipes', url: 'postgres://me:s3cret@db.local:5432/recipes', description: 'My recipes' });
    expect(await databases.findByText('postgres://me@db.local:5432/recipes')).toBeTruthy(); // no password
    expect((databases.getByLabelText('Address') as HTMLInputElement).value).toBe(''); // the form starts over
    expect(switches()).toBe('tools=true search=false');

    fireEvent.click(databases.getByRole('button', { name: 'Add a SQLite file…' }));
    expect(await databases.findByText('Give the database a name.')).toBeTruthy();
    expect(api.picks).toEqual([]); // no name yet: nothing asked
    fireEvent.change(databases.getByLabelText('Name'), { target: { value: 'notes' } });
    api.nextSqlite = 'C:\\data\\notes.sqlite';
    fireEvent.click(databases.getByRole('button', { name: 'Add a SQLite file…' }));
    expect(await databases.findByText('C:\\data\\notes.sqlite')).toBeTruthy();
    expect(api.picks).toEqual(['sqlite:notes']);
  });

  it('programs are read-only: listed, with Open mcp.json and Reload', async () => {
    const api = new FakeCompanionConfig(
      emptyCompanionConfig({
        servers: [
          { name: 'git', summary: 'uvx mcp-server-git', disabled: false },
          { name: 'old', summary: 'node old.js', disabled: true },
        ],
      }),
    );
    await loaded(api);
    const programs = within(panel('Programs'));
    expect(programs.getByText('git')).toBeTruthy();
    expect(programs.getByText('uvx mcp-server-git')).toBeTruthy();
    expect(programs.getByText('off')).toBeTruthy();
    expect(programs.getByText(/start programs on this computer, so they are changed only in the file/)).toBeTruthy();
    expect(programs.queryByRole('textbox')).toBeNull();
    expect(programs.queryByRole('button', { name: /Remove/ })).toBeNull();

    fireEvent.click(programs.getByRole('button', { name: 'Open mcp.json' }));
    await waitFor(() => expect(api.opened).toBe(1));
    fireEvent.click(programs.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.reloads).toBe(1));
  });

  it('a file that does not parse is said at the top with Open and Reload, and the sections cannot be changed', async () => {
    const api = new FakeCompanionConfig(emptyCompanionConfig({ problems: ['mcp.json: expected `,` or `}` at line 4 column 3'] }));
    await loaded(api);
    const banner = within(panel('A file could not be read'));
    expect(banner.getByText(/expected `,` or `}` at line 4 column 3/)).toBeTruthy();
    fireEvent.click(banner.getByRole('button', { name: 'Open mcp.json' }));
    await waitFor(() => expect(api.opened).toBe(1));
    fireEvent.click(banner.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.reloads).toBe(1));
    expect((within(panel('Folders she may read')).getByRole('button', { name: 'Add a folder…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel('Home Assistant')).getByLabelText('Home Assistant address') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('SettingsPanel — On this computer, only in the app', () => {
  it('renders nothing of it in a browser, and asks the shell nothing', () => {
    const api = new FakeCompanionConfig();
    render(<SettingsPanel companionConfig={api} deps={testDeps()} />);
    expect(screen.queryByText('On this computer')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Home Assistant' })).toBeNull();
    expect(api.reads).toBe(0);
  });

  it('in the app it follows Tools, and adding something turns on the Tools switch there', async () => {
    const invoke = vi.fn(async (command: string) => (command === 'os_notifications' ? false : { url: 'http://127.0.0.1:8790', token: 'tok' })) as unknown as Invoke;
    await initDesktop({ __TAURI__: { core: { invoke } }, fetch: vi.fn() as unknown as typeof fetch });
    const api = new FakeCompanionConfig();
    const deps = testDeps();
    render(<SettingsPanel companionConfig={api} deps={deps} />);
    await screen.findByRole('region', { name: 'Home Assistant' });

    const tools = screen.getByText('From the companion');
    const heading = screen.getByRole('heading', { name: 'On this computer' });
    expect(tools.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/Set them up under On this computer, below/)).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: "Offer the companion's tools" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    api.nextFolder = 'C:\\Notes';
    fireEvent.click(within(panel('Folders she may read')).getByRole('button', { name: 'Add a folder…' }));
    await within(panel('Folders she may read')).findByText('C:\\Notes');
    expect((screen.getByRole('switch', { name: "Offer the companion's tools" }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(loadSettings(deps.storage).tools.companion).toBe(true));
  });
});
