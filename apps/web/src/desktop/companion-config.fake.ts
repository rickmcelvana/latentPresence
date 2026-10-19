import type { CompanionConfig, CompanionConfigApi, CompanionConfigChange, DatabaseView } from './companion-config';

/** What nothing configured looks like. */
export function emptyCompanionConfig(overrides: Partial<CompanionConfig> = {}): CompanionConfig {
  return {
    mcpPath: 'C:\\Users\\me\\AppData\\Roaming\\latentPresence\\mcp.json',
    documentsPath: 'C:\\Users\\me\\AppData\\Roaming\\latentPresence\\documents.json',
    problems: [],
    home: null,
    roots: [],
    web: null,
    databases: [],
    servers: [],
    folders: [],
    embedding: null,
    ...overrides,
  };
}

/**
 * The shell's `companion_config*` commands over a `CompanionConfig` kept in memory, applying each
 * change the way the companion would (a typed token becomes `'stored'`; an omitted one keeps the
 * saved state). Records every call; a test sets `rejectNext` to make the next change refuse with
 * a sentence (a string, as Tauri rejects), and `nextFolder` / `nextSqlite` for what the system
 * dialog will return (`null`: the person cancelled).
 */
export class FakeCompanionConfig implements CompanionConfigApi {
  config: CompanionConfig;
  readonly changes: CompanionConfigChange[] = [];
  readonly picks: string[] = [];
  reads = 0;
  opened = 0;
  reloads = 0;
  rejectNext: string | null = null;
  readFails: string | null = null;
  nextFolder: string | null = null;
  nextSqlite: string | null = null;

  constructor(config: CompanionConfig = emptyCompanionConfig()) {
    this.config = config;
  }

  read(): Promise<CompanionConfig> {
    this.reads += 1;
    if (this.readFails !== null) return Promise.reject(this.readFails);
    return Promise.resolve(this.config);
  }

  change(change: CompanionConfigChange): Promise<CompanionConfig> {
    this.changes.push(change);
    if (this.rejectNext !== null) {
      const sentence = this.rejectNext;
      this.rejectNext = null;
      return Promise.reject(sentence);
    }
    this.config = this.apply(this.config, change);
    return Promise.resolve(this.config);
  }

  pickFolder(target: 'files' | 'documents'): Promise<CompanionConfig | null> {
    this.picks.push(target);
    const folder = this.nextFolder;
    if (folder === null) return Promise.resolve(null);
    this.config = target === 'files' ? { ...this.config, roots: [...this.config.roots, folder] } : { ...this.config, folders: [...this.config.folders, folder] };
    return Promise.resolve(this.config);
  }

  pickSqlite(name: string): Promise<CompanionConfig | null> {
    this.picks.push(`sqlite:${name}`);
    const path = this.nextSqlite;
    if (path === null) return Promise.resolve(null);
    const database: DatabaseView = { name, description: null, address: null, path, secret: 'missing', disabled: false, problem: null };
    this.config = { ...this.config, databases: [...this.config.databases, database] };
    return Promise.resolve(this.config);
  }

  openFile(): Promise<void> {
    this.opened += 1;
    return Promise.resolve();
  }

  reload(): Promise<CompanionConfig> {
    this.reloads += 1;
    return Promise.resolve(this.config);
  }

  private apply(config: CompanionConfig, change: CompanionConfigChange): CompanionConfig {
    switch (change.kind) {
      case 'home':
        return { ...config, home: { url: change.url, token: change.token === undefined ? (config.home?.token ?? 'missing') : 'stored', problem: null } };
      case 'removeHome':
        return { ...config, home: null };
      case 'web':
        return {
          ...config,
          web: {
            provider: change.provider,
            url: change.url ?? null,
            key: change.key === undefined ? (config.web?.key ?? 'missing') : 'stored',
            readPages: change.readPages,
            problem: null,
          },
        };
      case 'removeWeb':
        return { ...config, web: null };
      case 'removeRoot':
        return { ...config, roots: config.roots.filter((path) => path !== change.path) };
      case 'addDatabase':
        return {
          ...config,
          databases: [
            ...config.databases,
            { name: change.name, description: change.description ?? null, address: redacted(change.url), path: null, secret: 'stored', disabled: false, problem: null },
          ],
        };
      case 'removeDatabase':
        return { ...config, databases: config.databases.filter((database) => database.name !== change.name) };
      case 'storeDatabase': {
        const found = config.databases.find((database) => database.name === change.name);
        if (found?.secret !== 'inFile') throw new Error(`"${change.name}" has no address in mcp.json to move.`);
        return { ...config, databases: config.databases.map((database) => (database === found ? { ...database, secret: 'stored' } : database)) };
      }
      case 'removeDocumentsFolder':
        return { ...config, folders: config.folders.filter((path) => path !== change.path) };
      case 'embedding':
        return { ...config, embedding: change.embedding };
    }
  }
}

/** An address without its password, as the companion shows it. */
function redacted(address: string): string {
  return address.replace(/:\/\/([^:/@]+):[^@]*@/, '://$1@');
}
