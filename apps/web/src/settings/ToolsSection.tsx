import { useState } from 'react';
import type { ReactElement } from 'react';
import { effectivePolicy, toolFingerprint, type ToolPolicy } from '@latentpresence/core';
import type { McpToolInfo, McpTransport } from '@latentpresence/protocol';
import { connectCompanionTools, connectToolServer, type ConnectMcp, type ToolServerStatus } from '../chat/chat-tools';
import { KeyField } from './KeyField';
import { mcpKeyRef, type ToolServerSetting, type ToolsSettings } from './settings';
import type { Vault } from './vault';

/**
 * Settings → Tools (P5-T01, ADR-42): the MCP servers the person adds, whether each is on, and
 * what she may do with each tool it offers.
 *
 * **Nothing here reaches a server until Test is pressed**, and Test only lists tools — it calls
 * none. A change goes up as an updater over the panel's own state, so two quick changes never
 * overwrite each other and the section never writes storage behind the panel's back. A bearer
 * token goes into the vault under `mcpKeyRef(id)` and nowhere else.
 */
export interface ToolsSectionProps {
  readonly tools: ToolsSettings;
  readonly onChange: (update: (previous: ToolsSettings) => ToolsSettings) => void;
  readonly vault: Vault;
  /** Test seam: the connection Test makes. Omitted, the real MCP adapter. */
  readonly connect?: ConnectMcp | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Where the companion listens: List asks it for the servers its `mcp.json` names (ADR-43). */
  readonly companionUrl: string;
  /** Test seam: what List asks. Omitted, the companion's real `/mcp/tools`. */
  readonly listCompanion?: Parameters<typeof connectCompanionTools>[0]['listCompanion'] | undefined;
}

/** What List found out about the companion's servers, kept only while Settings is open. */
interface CompanionListing {
  readonly pending: boolean;
  readonly servers: readonly { readonly status: ToolServerStatus; readonly tools: readonly McpToolInfo[] }[];
}

/** What Test found out about one server, kept only while Settings is open. */
interface TestResult {
  readonly pending: boolean;
  readonly ok: boolean;
  readonly text: string;
  readonly tools: readonly McpToolInfo[];
}

const MAX_SERVERS = 16;
const LABEL_LIMIT = 40;
/** Past this a description is likely to need more than the two clamped lines. */
const LONG_DESCRIPTION = 120;

const TRANSPORT_LABELS: Record<McpTransport, string> = { http: 'Streamable HTTP', sse: 'SSE' };

const POLICY_OPTIONS: readonly { readonly value: ToolPolicy; readonly text: string }[] = [
  { value: 'ask', text: 'Ask first' },
  { value: 'auto', text: 'Always allow' },
  { value: 'never', text: 'Never' },
];

function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function ToolRow({
  info,
  grant,
  onPolicy,
}: {
  readonly info: McpToolInfo;
  readonly grant: ToolsSettings['grants'][string][string] | undefined;
  readonly onPolicy: (policy: ToolPolicy) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const { policy, changed } = effectivePolicy(grant, info);
  return (
    <li className="tools-tool">
      <div className="tools-tool-head">
        <span className="tools-tool-name">{info.name}</span>
        <select
          aria-label={`Policy for ${info.name}`}
          className="select"
          onChange={(event) => onPolicy(event.target.value as ToolPolicy)}
          value={policy}
        >
          {POLICY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.text}
            </option>
          ))}
        </select>
      </div>
      {info.description !== '' && (
        <p className={open ? 'tools-tool-description' : 'tools-tool-description tools-tool-description-clamped'}>{info.description}</p>
      )}
      {info.description.length > LONG_DESCRIPTION && (
        <button aria-expanded={open} className="btn btn-sm btn-ghost tools-tool-more" onClick={() => setOpen((was) => !was)} type="button">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
      {changed && <p className="settings-status settings-status-warn">Changed since you allowed it — she will ask again.</p>}
    </li>
  );
}

export function ToolsSection({ tools, onChange, vault, connect, fetch, companionUrl, listCompanion }: ToolsSectionProps): ReactElement {
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [listing, setListing] = useState<CompanionListing | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  // The new server's id is minted once, so a token saved in the vault before "Add" already
  // sits under the ref the server will use.
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [transport, setTransport] = useState<McpTransport>('http');
  const [auth, setAuth] = useState<ToolServerSetting['auth']>('none');
  const [formError, setFormError] = useState<string | null>(null);

  function add(): void {
    const trimmed = label.trim();
    const address = url.trim();
    if (trimmed === '') return setFormError('Give the server a name.');
    if (trimmed.length > LABEL_LIMIT) return setFormError(`Keep the name to ${LABEL_LIMIT} characters.`);
    if (!isHttpUrl(address)) return setFormError('The address must start with http:// or https://.');
    if (tools.servers.length >= MAX_SERVERS) return setFormError(`Up to ${MAX_SERVERS} servers.`);
    const server: ToolServerSetting = { id: draftId, label: trimmed, url: address, transport, enabled: true, auth };
    onChange((previous) => ({ ...previous, servers: [...previous.servers, server] }));
    setDraftId(crypto.randomUUID());
    setLabel('');
    setUrl('');
    setTransport('http');
    setAuth('none');
    setFormError(null);
  }

  function chooseAuth(next: ToolServerSetting['auth']): void {
    // A token typed for a server that will not use one should not linger in the vault.
    if (next === 'none') vault.forgetKey(mcpKeyRef(draftId));
    setAuth(next);
  }

  function setEnabled(id: string, enabled: boolean): void {
    onChange((previous) => ({ ...previous, servers: previous.servers.map((server) => (server.id === id ? { ...server, enabled } : server)) }));
  }

  function remove(id: string): void {
    vault.forgetKey(mcpKeyRef(id));
    onChange((previous) => {
      const { [id]: _dropped, ...grants } = previous.grants;
      return { ...previous, servers: previous.servers.filter((server) => server.id !== id), grants };
    });
    setResults(({ [id]: _dropped, ...rest }) => rest);
    setConfirming(null);
  }

  function setPolicy(serverId: string, info: McpToolInfo, policy: ToolPolicy): void {
    // Only "always allow" is bound to what the tool said it does; ask and never need no fingerprint.
    const grant = { policy, fingerprint: policy === 'auto' ? toolFingerprint(info) : null };
    onChange((previous) => ({ ...previous, grants: { ...previous.grants, [serverId]: { ...previous.grants[serverId], [info.name]: grant } } }));
  }

  async function test(server: ToolServerSetting): Promise<void> {
    setResults((current) => ({ ...current, [server.id]: { pending: true, ok: false, text: 'Testing…', tools: [] } }));
    const { connected, status } = await connectToolServer(server, {
      loadKey: (ref) => vault.loadKey(ref),
      ...(connect === undefined ? {} : { connect }),
      ...(fetch === undefined ? {} : { fetch }),
    });
    // Test only listed the tools; nothing keeps the connection open for the panel.
    if (connected !== null) void connected.client.close().catch(() => undefined);
    setResults((current) => ({
      ...current,
      [server.id]: {
        pending: false,
        ok: status.ok,
        text: status.ok ? `Connected — ${status.detail}` : status.detail,
        tools: connected?.tools ?? [],
      },
    }));
  }

  async function listFromCompanion(): Promise<void> {
    setListing({ pending: true, servers: [] });
    const { connected, statuses } = await connectCompanionTools({
      baseUrl: companionUrl,
      ...(listCompanion === undefined ? {} : { listCompanion }),
      ...(fetch === undefined ? {} : { fetch }),
    });
    // List only reads what the companion reports; the companion owns its servers, so nothing is closed here.
    setListing({
      pending: false,
      servers: statuses.map((status) => ({ status, tools: connected.find((server) => server.id === status.id)?.tools ?? [] })),
    });
  }

  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Tools</span>
      </div>
      <p className="panel-note">
        Tools come from MCP servers you add. She asks before using one unless you say otherwise, and nothing is sent to a server until she
        uses one of its tools.
      </p>

      {tools.servers.length > 0 && (
        <ul className="tools-server-list">
          {tools.servers.map((server) => {
            const result = results[server.id];
            return (
              <li className="tools-server" key={server.id}>
                <div className="tools-server-head">
                  <div className="tools-server-title">
                    <span className="tools-server-label">{server.label}</span>
                    <span className="tools-server-url">
                      {server.url} · {TRANSPORT_LABELS[server.transport]}
                    </span>
                  </div>
                  <label className="tools-switch">
                    <input
                      checked={server.enabled}
                      onChange={(event) => setEnabled(server.id, event.target.checked)}
                      role="switch"
                      type="checkbox"
                    />
                    <span>{server.enabled ? 'On' : 'Off'}</span>
                  </label>
                </div>

                <div className="settings-test-row">
                  <button className="btn btn-sm" disabled={result?.pending === true} onClick={() => void test(server)} type="button">
                    Test
                  </button>
                  {confirming === server.id ? (
                    <div className="memory-confirm">
                      <span>Remove {server.label}, its choices and its token?</span>
                      <button className="btn btn-sm btn-danger" onClick={() => remove(server.id)} type="button">
                        Confirm
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => setConfirming(null)} type="button">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button className="btn btn-sm btn-ghost" onClick={() => setConfirming(server.id)} type="button">
                      Remove
                    </button>
                  )}
                </div>

                <div aria-live="polite" className="settings-status-region">
                  {result !== undefined && (
                    <p className={result.pending ? 'settings-status settings-status-warn' : result.ok ? 'settings-status settings-status-ok' : 'settings-status settings-status-danger'}>
                      {result.text}
                    </p>
                  )}
                </div>

                {result !== undefined && result.tools.length > 0 && (
                  <ul className="tools-tool-list">
                    {result.tools.map((info) => (
                      <ToolRow
                        grant={tools.grants[server.id]?.[info.name]}
                        info={info}
                        key={info.name}
                        onPolicy={(policy) => setPolicy(server.id, info, policy)}                      />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="tools-companion">
        <span className="panel-title">From the companion</span>
        <p className="panel-note">
          The companion can run servers listed in its own mcp.json, on this computer and edited by you, including a read-only Files server for
          folders you name there. They are off until you turn this on.
        </p>
        <label className="tools-switch">
          <input
            checked={tools.companion}
            onChange={(event) => {
              const companion = event.target.checked;
              onChange((previous) => ({ ...previous, companion }));
            }}
            role="switch"
            type="checkbox"
          />
          <span>Offer the companion&apos;s tools</span>
        </label>
        <div className="settings-test-row">
          <button className="btn btn-sm" disabled={listing?.pending === true} onClick={() => void listFromCompanion()} type="button">
            List
          </button>
        </div>
        <div aria-live="polite" className="settings-status-region">
          {listing?.pending === true && <p className="settings-status settings-status-warn">Listing…</p>}
          {listing !== null &&
            !listing.pending &&
            listing.servers.map(({ status, tools: serverTools }) => (
              <div className="tools-server" key={status.id}>
                <p className={status.ok ? 'settings-status settings-status-ok' : 'settings-status settings-status-danger'}>
                  {status.label} — {status.detail}
                </p>
                {status.ok && serverTools.length > 0 && (
                  <ul className="tools-tool-list">
                    {serverTools.map((info) => (
                      <ToolRow
                        grant={tools.grants[status.id]?.[info.name]}
                        info={info}
                        key={info.name}
                        onPolicy={(policy) => setPolicy(status.id, info, policy)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ))}
        </div>
      </div>

      <div className="tools-add">
        <span className="panel-title">Add a server</span>
        <div className="field">
          <label className="field-label" htmlFor="tools-add-label">
            Name
          </label>
          <input className="input" id="tools-add-label" maxLength={LABEL_LIMIT} onChange={(event) => setLabel(event.target.value)} value={label} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tools-add-url">
            Address
          </label>
          <input
            className="input"
            id="tools-add-url"
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/mcp"
            spellCheck={false}
            type="url"
            value={url}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tools-add-transport">
            Connection
          </label>
          <select className="select" id="tools-add-transport" onChange={(event) => setTransport(event.target.value as McpTransport)} value={transport}>
            <option value="http">{TRANSPORT_LABELS.http}</option>
            <option value="sse">{TRANSPORT_LABELS.sse}</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tools-add-auth">
            Sign-in
          </label>
          <select className="select" id="tools-add-auth" onChange={(event) => chooseAuth(event.target.value as ToolServerSetting['auth'])} value={auth}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
          </select>
        </div>
        {auth === 'bearer' && <KeyField id="tools-add-token" key={draftId} label="Token" refKey={mcpKeyRef(draftId)} vault={vault} />}
        {formError !== null && <p className="settings-status settings-status-danger" role="alert">{formError}</p>}
        <div>
          <button className="btn btn-primary" onClick={add} type="button">
            Add server
          </button>
        </div>
      </div>
    </section>
  );
}
