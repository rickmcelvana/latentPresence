import type { Invoke } from './desktop';

/**
 * The companion's own settings, in the desktop app (P8-T06, ADR-63): what `mcp.json` and
 * `documents.json` say, read and changed through the shell (`companion_config*`, the companion's
 * `config_edit`). Shapes mirror `companion/crates/server/src/config_edit.rs`.
 *
 * - **No secret ever comes back**: a token, key or database address is only *where* it is
 *   (`SecretState`); one written in the file is moved to Credential Manager when its section is
 *   saved.
 * - **The page never names a folder.** There is no change that adds one: `pickFolder` asks the
 *   shell to open the system's folder dialog, and the folder the person picks is added there.
 * - **Programs (`mcpServers`) are shown, never changed**: `openFile` opens `mcp.json` for that.
 * - Every change restarts the companion; the result is the settings as they now are, or a
 *   rejection with the companion's own sentence for what was wrong.
 */

/** Where a secret is: nowhere, in the file in plain text, or in Credential Manager. */
export type SecretState = 'missing' | 'inFile' | 'stored';

export interface HomeView {
  readonly url: string;
  readonly token: SecretState;
  /** The companion's reason for refusing it, when it would. */
  readonly problem: string | null;
}

export type SearchProvider = 'searxng' | 'tavily' | 'brave';

export interface WebView {
  readonly provider: string | null;
  /** SearXNG's address. */
  readonly url: string | null;
  readonly key: SecretState;
  readonly readPages: boolean;
  readonly problem: string | null;
}

export interface DatabaseView {
  readonly name: string;
  readonly description: string | null;
  /** The address without its password. */
  readonly address: string | null;
  /** A SQLite file. */
  readonly path: string | null;
  readonly secret: SecretState;
  readonly disabled: boolean;
  readonly problem: string | null;
}

export interface ServerView {
  readonly name: string;
  /** The command line or address, to recognise it by. */
  readonly summary: string;
  readonly disabled: boolean;
  /** The plugin that added it (P10-T07, ADR-72 item 7); null for one the person wrote. */
  readonly plugin: string | null;
}

/** A plugin's stdio server, as its manifest has it, for the shell to ask about (P10-T07). */
export interface PluginServerRequest {
  readonly plugin: string;
  readonly pluginName: string;
  readonly server: string;
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface EmbeddingView {
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
  readonly documentPrefix: string;
  readonly queryPrefix: string;
}

export interface CompanionConfig {
  readonly mcpPath: string;
  readonly documentsPath: string;
  /** A file that does not parse; its sections show empty and cannot be changed until it is fixed. */
  readonly problems: readonly string[];
  readonly home: HomeView | null;
  /** Folders the Files server may read. */
  readonly roots: readonly string[];
  /** The ones among them she may also make documents and spreadsheets in (ADR-73). */
  readonly writable: readonly string[];
  readonly web: WebView | null;
  readonly databases: readonly DatabaseView[];
  readonly servers: readonly ServerView[];
  /** Folders of documents she can search. */
  readonly folders: readonly string[];
  readonly embedding: EmbeddingView | null;
}

/** One change. `token` / `key` omitted keeps the saved one. There is no way to add a folder here. */
export type CompanionConfigChange =
  | { readonly kind: 'home'; readonly url: string; readonly token?: string }
  | { readonly kind: 'removeHome' }
  | { readonly kind: 'web'; readonly provider: SearchProvider | null; readonly url?: string; readonly key?: string; readonly readPages: boolean }
  | { readonly kind: 'removeWeb' }
  | { readonly kind: 'removeRoot'; readonly path: string }
  /** ADR-73: she may no longer write there. Opening one for writing is `openFolderForWriting`. */
  | { readonly kind: 'closeRootForWriting'; readonly path: string }
  | { readonly kind: 'addDatabase'; readonly name: string; readonly url: string; readonly description?: string }
  | { readonly kind: 'removeDatabase'; readonly name: string }
  /** A database whose address is written in `mcp.json`: the address moves to Credential Manager. */
  | { readonly kind: 'storeDatabase'; readonly name: string }
  | { readonly kind: 'removeDocumentsFolder'; readonly path: string }
  | { readonly kind: 'embedding'; readonly embedding: EmbeddingView | null };

export interface CompanionConfigApi {
  read(): Promise<CompanionConfig>;
  /** Rejects with the companion's sentence when it would refuse the result. */
  change(change: CompanionConfigChange): Promise<CompanionConfig>;
  /** The system's folder dialog; `null` when the person cancels. */
  pickFolder(target: 'files' | 'documents'): Promise<CompanionConfig | null>;
  /** A SQLite file as database `name`, from the system's file dialog; `null` when cancelled. */
  pickSqlite(name: string): Promise<CompanionConfig | null>;
  /** Opens `mcp.json` in the app Windows uses for `.json`. */
  openFile(): Promise<void>;
  /** Restarts the companion on the files as they are: after a hand edit. */
  reload(): Promise<CompanionConfig>;
  /**
   * A plugin's program (ADR-72 item 7): the shell shows the whole command in its own dialog and adds
   * it, tagged, only on yes. `null` when the person says no.
   */
  addPluginServer(request: PluginServerRequest): Promise<CompanionConfig | null>;
  /** Removes the servers this plugin added, and only those. */
  removePluginServers(plugin: string): Promise<CompanionConfig>;
  /**
   * ADR-73: lets her write in one of the Files folders. The shell asks in its own dialog and
   * writes it only on yes; `null` when the person says no.
   */
  openFolderForWriting(path: string): Promise<CompanionConfig | null>;
}

export function companionConfigApi(invoke: Invoke): CompanionConfigApi {
  return {
    read: () => invoke<CompanionConfig>('companion_config'),
    change: (change) => invoke<CompanionConfig>('companion_config_change', { change }),
    pickFolder: (target) => invoke<CompanionConfig | null>('companion_config_pick_folder', { target }),
    pickSqlite: (name) => invoke<CompanionConfig | null>('companion_config_pick_sqlite', { name }),
    openFile: () => invoke<void>('companion_config_open'),
    reload: () => invoke<CompanionConfig>('companion_config_reload'),
    addPluginServer: (request) => invoke<CompanionConfig | null>('companion_config_add_plugin_server', { request }),
    removePluginServers: (plugin) => invoke<CompanionConfig>('companion_config_remove_plugin_servers', { plugin }),
    openFolderForWriting: (path) => invoke<CompanionConfig | null>('companion_config_open_folder_for_writing', { path }),
  };
}
