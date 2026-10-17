import { useState } from 'react';
import type { ReactElement } from 'react';
import type { DatabaseView, EmbeddingView, SearchProvider, SecretState } from '../desktop/companion-config';
import type { CompanionController, CompanionTopic } from './companion-config-state';

/**
 * The companion's own settings, one panel per topic (P8-T06). Each takes the controller from
 * `useCompanionConfig`, so Settings shows all of them and the wizard shows three, over the same
 * state. A secret never renders back (it is only *where* it is); a refusal's sentence shows in
 * the panel that caused it, as the companion wrote it.
 */

export interface PanelProps {
  readonly controller: CompanionController;
}

/** The sentence a topic was refused with, and what was done on its behalf, if any. */
function Outcome({ controller, topic }: { readonly controller: CompanionController; readonly topic: CompanionTopic }): ReactElement {
  const error = controller.errors[topic];
  const notice = controller.notices[topic];
  return (
    <div aria-live="polite" className="settings-status-region">
      {error !== undefined && <p className="settings-status settings-status-danger">{error}</p>}
      {notice !== undefined && <p className="settings-status settings-status-ok">{notice}</p>}
    </div>
  );
}

const SECRET_PILL: Record<SecretState, { readonly tone: string; readonly text: string }> = {
  stored: { tone: 'pill-ok', text: 'Saved in Credential Manager' },
  inFile: { tone: 'pill-warn', text: 'In mcp.json, in plain text' },
  missing: { tone: 'pill-danger', text: 'None saved' },
};

/** A token, key or address as `KeyField` treats a key: an input when there is none or when replacing, otherwise a pill. */
function SecretField({
  id,
  label,
  state,
  value,
  onChange,
  disabled,
  placeholder,
  hint,
}: {
  readonly id: string;
  readonly label: string;
  readonly state: SecretState;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly hint?: string;
}): ReactElement {
  const [replacing, setReplacing] = useState(false);
  const showInput = state === 'missing' || replacing;
  const pill = SECRET_PILL[state];
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {showInput ? (
        <div className="settings-key-row">
          <input
            autoComplete="off"
            className="input"
            disabled={disabled}
            id={id}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            type="password"
            value={value}
          />
          {replacing && state !== 'missing' && (
            <button
              className="btn btn-sm btn-ghost"
              disabled={disabled}
              onClick={() => {
                setReplacing(false);
                onChange('');
              }}
              type="button"
            >
              Keep the saved one
            </button>
          )}
        </div>
      ) : (
        <div className="settings-key-row">
          <span className={`pill ${pill.tone}`}>{pill.text}</span>
          <button className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => setReplacing(true)} type="button">
            Replace
          </button>
        </div>
      )}
      {state === 'inFile' && !replacing && <span className="field-hint">Saving this section moves it to Windows Credential Manager.</span>}
      {hint !== undefined && <span className="field-hint">{hint}</span>}
    </div>
  );
}

/** A path she may read from or search, with its Remove. */
function PathRow({ path, remove, disabled }: { readonly path: string; readonly remove: () => void; readonly disabled: boolean }): ReactElement {
  return (
    <li className="companion-row">
      <code className="companion-path">{path}</code>
      <button aria-label={`Remove ${path}`} className="btn btn-sm btn-danger" disabled={disabled} onClick={remove} type="button">
        Remove
      </button>
    </li>
  );
}

// --- Home Assistant -----------------------------------------------------------------------

function HomeForm({ controller, locked }: PanelProps & { readonly locked: boolean }): ReactElement {
  const home = controller.config?.home ?? null;
  const [url, setUrl] = useState(home?.url ?? '');
  const [token, setToken] = useState('');
  const disabled = controller.busy || locked;
  const state = controller.homeState;
  const tone = state === null || state.pending ? 'warn' : state.tone;

  function save(): void {
    void controller.change('home', { kind: 'home', url: url.trim(), ...(token === '' ? {} : { token }) });
  }

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="companion-home-url">
          Home Assistant address
        </label>
        <input
          autoComplete="off"
          className="input"
          disabled={disabled}
          id="companion-home-url"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://homeassistant.local:8123"
          spellCheck={false}
          type="text"
          value={url}
        />
        <span className="field-hint">
          The address you open Home Assistant at, like <code>http://homeassistant.local:8123</code>.
        </span>
      </div>
      <SecretField
        disabled={disabled}
        hint="In Home Assistant: your profile, then Security, then Long-lived access tokens, then Create token."
        id="companion-home-token"
        label="Access token"
        onChange={setToken}
        placeholder="Paste a token"
        state={home?.token ?? 'missing'}
        value={token}
      />
      {home?.problem != null && <p className="settings-status settings-status-danger">{home.problem}</p>}
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={disabled || url.trim() === ''} onClick={save} type="button">
          Save
        </button>
        {home !== null && (
          <>
            <button className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => void controller.checkHome()} type="button">
              Check
            </button>
            <button className="btn btn-sm btn-danger" disabled={disabled} onClick={() => void controller.change('home', { kind: 'removeHome' })} type="button">
              Remove
            </button>
          </>
        )}
      </div>
      <div aria-live="polite" className="settings-status-region">
        {state !== null && <p className={`settings-status settings-status-${tone}`}>{state.text}</p>}
      </div>
    </>
  );
}

export function HomePanel({ controller, locked }: PanelProps & { readonly locked: boolean }): ReactElement {
  return (
    <section aria-label="Home Assistant" className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Home Assistant</span>
      </div>
      <p className="panel-note">
        Lets her see and control your devices. Her permission for each device starts as &quot;Ask first&quot; and is set under Tools, List.
      </p>
      <HomeForm controller={controller} key={controller.version('home')} locked={locked} />
      <Outcome controller={controller} topic="home" />
    </section>
  );
}

// --- Folders she may read -----------------------------------------------------------------

export function FilesPanel({ controller, locked }: PanelProps & { readonly locked: boolean }): ReactElement {
  const roots = controller.config?.roots ?? [];
  const disabled = controller.busy || locked;
  return (
    <section aria-label="Folders she may read" className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Folders she may read</span>
      </div>
      <p className="panel-note">Your notes, for example. She can only read what is in them, never change it.</p>
      {roots.length === 0 ? (
        <p className="field-hint">No folders yet.</p>
      ) : (
        <ul className="companion-list">
          {roots.map((path) => (
            <PathRow disabled={disabled} key={path} path={path} remove={() => void controller.change('files', { kind: 'removeRoot', path })} />
          ))}
        </ul>
      )}
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={disabled} onClick={() => void controller.pickFolder('files')} type="button">
          Add a folder…
        </button>
      </div>
      <Outcome controller={controller} topic="files" />
    </section>
  );
}

// --- Documents she can search -------------------------------------------------------------

const OLLAMA_EMBEDDING: EmbeddingView = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'nomic-embed-text',
  dimensions: 768,
  documentPrefix: 'search_document: ',
  queryPrefix: 'search_query: ',
};

function EmbeddingForm({ controller, locked }: PanelProps & { readonly locked: boolean }): ReactElement {
  const saved = controller.config?.embedding ?? null;
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? '');
  const [model, setModel] = useState(saved?.model ?? '');
  const [dimensions, setDimensions] = useState(saved === null ? '' : String(saved.dimensions));
  const [documentPrefix, setDocumentPrefix] = useState(saved?.documentPrefix ?? '');
  const [queryPrefix, setQueryPrefix] = useState(saved?.queryPrefix ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const disabled = controller.busy || locked;

  function fillOllama(): void {
    setBaseUrl(OLLAMA_EMBEDDING.baseUrl);
    setModel(OLLAMA_EMBEDDING.model);
    setDimensions(String(OLLAMA_EMBEDDING.dimensions));
    setDocumentPrefix(OLLAMA_EMBEDDING.documentPrefix);
    setQueryPrefix(OLLAMA_EMBEDDING.queryPrefix);
    setProblem(null);
  }

  function save(): void {
    const count = Number(dimensions);
    if (!Number.isInteger(count) || count < 1) {
      setProblem('Dimensions is a whole number, like 768.');
      return;
    }
    setProblem(null);
    void controller.change('embedding', {
      kind: 'embedding',
      embedding: { baseUrl: baseUrl.trim(), model: model.trim(), dimensions: count, documentPrefix, queryPrefix },
    });
  }

  return (
    <>
      <p className="field-hint">
        {saved === null
          ? 'Keyword search only. An embedding model lets her find documents by meaning as well.'
          : 'An embedding model finds documents by meaning as well as by words.'}
      </p>
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={disabled} onClick={fillOllama} type="button">
          Use Ollama&apos;s nomic-embed-text
        </button>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="companion-embedding-url">
          Embedding model address
        </label>
        <input
          className="input"
          disabled={disabled}
          id="companion-embedding-url"
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://127.0.0.1:11434/v1"
          spellCheck={false}
          type="text"
          value={baseUrl}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="companion-embedding-model">
          Model
        </label>
        <input
          className="input"
          disabled={disabled}
          id="companion-embedding-model"
          onChange={(event) => setModel(event.target.value)}
          placeholder="nomic-embed-text"
          spellCheck={false}
          type="text"
          value={model}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="companion-embedding-dimensions">
          Dimensions
        </label>
        <input
          className="input"
          disabled={disabled}
          id="companion-embedding-dimensions"
          inputMode="numeric"
          onChange={(event) => setDimensions(event.target.value)}
          placeholder="768"
          type="text"
          value={dimensions}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="companion-embedding-document-prefix">
          Document prefix
        </label>
        <input
          className="input"
          disabled={disabled}
          id="companion-embedding-document-prefix"
          onChange={(event) => setDocumentPrefix(event.target.value)}
          spellCheck={false}
          type="text"
          value={documentPrefix}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="companion-embedding-query-prefix">
          Query prefix
        </label>
        <input
          className="input"
          disabled={disabled}
          id="companion-embedding-query-prefix"
          onChange={(event) => setQueryPrefix(event.target.value)}
          spellCheck={false}
          type="text"
          value={queryPrefix}
        />
        <span className="field-hint">Some models want a few words in front of the text they embed; leave both prefixes empty if yours does not.</span>
      </div>
      {problem !== null && <p className="settings-status settings-status-danger">{problem}</p>}
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={disabled || baseUrl.trim() === '' || model.trim() === ''} onClick={save} type="button">
          Save the embedding model
        </button>
        {saved !== null && (
          <button
            className="btn btn-sm btn-danger"
            disabled={disabled}
            onClick={() => void controller.change('embedding', { kind: 'embedding', embedding: null })}
            type="button"
          >
            Remove the embedding model
          </button>
        )}
      </div>
    </>
  );
}

export function DocumentsPanel({ controller, locked }: PanelProps & { readonly locked: boolean }): ReactElement {
  const folders = controller.config?.folders ?? [];
  const disabled = controller.busy || locked;
  return (
    <section aria-label="Documents she can search" className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Documents she can search</span>
      </div>
      <p className="panel-note">Manuals, papers, anything you want her to look things up in. The companion indexes these folders.</p>
      {folders.length === 0 ? (
        <p className="field-hint">No folders yet.</p>
      ) : (
        <ul className="companion-list">
          {folders.map((path) => (
            <PathRow disabled={disabled} key={path} path={path} remove={() => void controller.change('documents', { kind: 'removeDocumentsFolder', path })} />
          ))}
        </ul>
      )}
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={disabled} onClick={() => void controller.pickFolder('documents')} type="button">
          Add a folder…
        </button>
      </div>
      <Outcome controller={controller} topic="documents" />
      <div className="companion-subsection">
        <span className="panel-title">Embedding model</span>
        <EmbeddingForm controller={controller} key={controller.version('embedding')} locked={locked} />
        <Outcome controller={controller} topic="embedding" />
      </div>
    </section>
  );
}

// --- Web search ---------------------------------------------------------------------------

const PROVIDERS: readonly { readonly value: SearchProvider | ''; readonly text: string }[] = [
  { value: '', text: 'None' },
  { value: 'searxng', text: 'SearXNG' },
  { value: 'tavily', text: 'Tavily' },
  { value: 'brave', text: 'Brave' },
];

function asProvider(value: string | null | undefined): SearchProvider | '' {
  return value === 'searxng' || value === 'tavily' || value === 'brave' ? value : '';
}

function WebForm({ controller, locked }: PanelProps & { readonly locked: boolean }): ReactElement {
  const saved = controller.config?.web ?? null;
  const [provider, setProvider] = useState<SearchProvider | ''>(asProvider(saved?.provider));
  const [url, setUrl] = useState(saved?.url ?? '');
  const [key, setKey] = useState('');
  const [readPages, setReadPages] = useState(saved?.readPages ?? false);
  const disabled = controller.busy || locked;
  // A key saved for another provider is not this one's.
  const keyState: SecretState = saved !== null && asProvider(saved.provider) === provider ? saved.key : 'missing';

  function save(): void {
    void controller.change('web', {
      kind: 'web',
      provider: provider === '' ? null : provider,
      ...(provider === 'searxng' ? { url: url.trim() } : {}),
      ...((provider === 'tavily' || provider === 'brave') && key !== '' ? { key } : {}),
      readPages,
    });
  }

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor="companion-web-provider">
          Search provider
        </label>
        <select className="select" disabled={disabled} id="companion-web-provider" onChange={(event) => setProvider(asProvider(event.target.value))} value={provider}>
          {PROVIDERS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.text}
            </option>
          ))}
        </select>
      </div>
      {provider === 'searxng' && (
        <div className="field">
          <label className="field-label" htmlFor="companion-web-url">
            SearXNG address
          </label>
          <input
            className="input"
            disabled={disabled}
            id="companion-web-url"
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://127.0.0.1:8080"
            spellCheck={false}
            type="text"
            value={url}
          />
        </div>
      )}
      {(provider === 'tavily' || provider === 'brave') && (
        <SecretField
          disabled={disabled}
          id="companion-web-key"
          key={provider}
          label={provider === 'tavily' ? 'Tavily API key' : 'Brave API key'}
          onChange={setKey}
          placeholder="Paste a key"
          state={keyState}
          value={key}
        />
      )}
      <label className="tools-switch">
        <input checked={readPages} disabled={disabled} onChange={(event) => setReadPages(event.target.checked)} type="checkbox" />
        <span>She may also read web pages</span>
      </label>
      {saved?.problem != null && <p className="settings-status settings-status-danger">{saved.problem}</p>}
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={disabled || (provider === '' && !readPages)} onClick={save} type="button">
          Save
        </button>
        {saved !== null && (
          <button className="btn btn-sm btn-danger" disabled={disabled} onClick={() => void controller.change('web', { kind: 'removeWeb' })} type="button">
            Remove
          </button>
        )}
      </div>
    </>
  );
}

export function WebPanel({ controller, locked }: PanelProps & { readonly locked: boolean }): ReactElement {
  return (
    <section aria-label="Web search" className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Web search</span>
      </div>
      <p className="panel-note">Lets her search the web. What she searches for goes to the provider you choose.</p>
      <WebForm controller={controller} key={controller.version('web')} locked={locked} />
      <Outcome controller={controller} topic="web" />
    </section>
  );
}

// --- Databases ----------------------------------------------------------------------------

const DATABASE_NAME = /^[A-Za-z0-9_-]+$/;

function DatabaseRow({ database, controller, locked }: PanelProps & { readonly database: DatabaseView; readonly locked: boolean }): ReactElement {
  const pill = SECRET_PILL[database.secret];
  return (
    <li className="companion-row companion-database">
      <div className="companion-database-head">
        <span className="tools-server-label">{database.name}</span>
        {database.disabled && <span className="pill pill-warn">off</span>}
        {database.path === null && <span className={`pill ${pill.tone}`}>{pill.text}</span>}
        <button
          aria-label={`Remove ${database.name}`}
          className="btn btn-sm btn-danger"
          disabled={controller.busy || locked}
          onClick={() => void controller.change('databases', { kind: 'removeDatabase', name: database.name })}
          type="button"
        >
          Remove
        </button>
      </div>
      {database.description !== null && database.description !== '' && <span className="field-hint">{database.description}</span>}
      <code className="companion-path">{database.path ?? database.address ?? ''}</code>
      {database.problem !== null && <p className="settings-status settings-status-danger">{database.problem}</p>}
    </li>
  );
}

function DatabaseAdd({ controller, locked }: PanelProps & { readonly locked: boolean }): ReactElement {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const disabled = controller.busy || locked;

  function nameProblem(): string | null {
    const trimmed = name.trim();
    if (trimmed === '') return 'Give the database a name.';
    return DATABASE_NAME.test(trimmed) ? null : 'A name is letters, digits, - and _ only.';
  }

  function add(): void {
    const found = nameProblem();
    setProblem(found);
    if (found !== null) return;
    const note = description.trim();
    void controller.change('databases', { kind: 'addDatabase', name: name.trim(), url: address.trim(), ...(note === '' ? {} : { description: note }) });
  }

  function addSqlite(): void {
    const found = nameProblem();
    setProblem(found);
    if (found !== null) return;
    void controller.pickSqlite(name.trim());
  }

  return (
    <div className="companion-subsection">
      <span className="panel-title">Add a database</span>
      <div className="field">
        <label className="field-label" htmlFor="companion-database-name">
          Name
        </label>
        <input
          className="input"
          disabled={disabled}
          id="companion-database-name"
          onChange={(event) => setName(event.target.value)}
          placeholder="recipes"
          spellCheck={false}
          type="text"
          value={name}
        />
        <span className="field-hint">Letters, digits, - and _.</span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="companion-database-address">
          Address
        </label>
        <input
          autoComplete="off"
          className="input"
          disabled={disabled}
          id="companion-database-address"
          onChange={(event) => setAddress(event.target.value)}
          placeholder="postgres://user:password@host:5432/dbname"
          spellCheck={false}
          type="password"
          value={address}
        />
        <span className="field-hint">
          Starts with <code>postgres://</code>, <code>mysql://</code> or <code>mariadb://</code>. It is kept in Windows Credential Manager and the password is never shown again.
        </span>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="companion-database-description">
          What is in it (optional)
        </label>
        <input
          className="input"
          disabled={disabled}
          id="companion-database-description"
          onChange={(event) => setDescription(event.target.value)}
          placeholder="My recipes and shopping lists"
          type="text"
          value={description}
        />
      </div>
      {problem !== null && <p className="settings-status settings-status-danger">{problem}</p>}
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={disabled || address.trim() === ''} onClick={add} type="button">
          Add the database
        </button>
        <button className="btn btn-sm" disabled={disabled} onClick={addSqlite} type="button">
          Add a SQLite file…
        </button>
      </div>
    </div>
  );
}

export function DatabasesPanel({ controller, locked }: PanelProps & { readonly locked: boolean }): ReactElement {
  const databases = controller.config?.databases ?? [];
  return (
    <section aria-label="Databases she may query" className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Databases she may query</span>
      </div>
      <p className="panel-note">She can only read from these, never change them.</p>
      {databases.length === 0 ? (
        <p className="field-hint">No databases yet.</p>
      ) : (
        <ul className="companion-list">
          {databases.map((database) => (
            <DatabaseRow controller={controller} database={database} key={database.name} locked={locked} />
          ))}
        </ul>
      )}
      <DatabaseAdd controller={controller} key={controller.version('databases')} locked={locked} />
      <Outcome controller={controller} topic="databases" />
    </section>
  );
}

// --- Programs -----------------------------------------------------------------------------

export function ProgramsPanel({ controller }: PanelProps): ReactElement {
  const servers = controller.config?.servers ?? [];
  const path = controller.config?.mcpPath ?? 'mcp.json';
  return (
    <section aria-label="Programs" className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Programs</span>
      </div>
      <p className="panel-note">
        These start programs on this computer, so they are changed only in the file, <code className="companion-path">{path}</code>. After editing it,
        press Reload.
      </p>
      {servers.length === 0 ? (
        <p className="field-hint">No programs listed.</p>
      ) : (
        <ul className="companion-list">
          {servers.map((server) => (
            <li className="companion-row companion-database" key={server.name}>
              <div className="companion-database-head">
                <span className="tools-server-label">{server.name}</span>
                {server.disabled && <span className="pill pill-warn">off</span>}
              </div>
              <code className="companion-path">{server.summary}</code>
            </li>
          ))}
        </ul>
      )}
      <FileButtons controller={controller} />
      <Outcome controller={controller} topic="programs" />
    </section>
  );
}

/** Open mcp.json and Reload: for programs, and for a file that does not parse. */
export function FileButtons({ controller }: PanelProps): ReactElement {
  return (
    <div className="settings-test-row">
      <button className="btn btn-sm" onClick={() => void controller.openFile()} type="button">
        Open mcp.json
      </button>
      <button className="btn btn-sm" disabled={controller.busy} onClick={() => void controller.reload()} type="button">
        Reload
      </button>
    </div>
  );
}
