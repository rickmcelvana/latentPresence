import { useEffect, useState, type ChangeEvent, type ReactElement } from 'react';
import type { PluginIndexEntry } from '@latentpresence/protocol';
import { Schedules, pluginBudget, type ScheduleRequest, type ScheduleResult } from '@latentpresence/core';
import type { JsonValue, MemoryStore, PluginSetting } from '@latentpresence/protocol';
import { PACKS, packFor } from '../characters/packs';
import { chooseMemoryStore } from '../chat/chat-memory';
import { companionConfigApi, type CompanionConfigApi } from '../desktop/companion-config';
import { desktopShell } from '../desktop/desktop';
import type { Settings } from '../settings/settings';
import { PluginAssets } from './assets';
import { PLUGIN_INDEX_URL, fetchPluginIndex, sourceFromIndex, type PluginIndexRead } from './browse';
import { inspectPlugin, type PluginInspection } from './inspect';
import { enabledPlugins, installPlugin, loadPlugin, removePlugin, withPluginEnabled, withPluginLazy, withPluginSetting, withoutPlugin, type LoadedPlugin } from './manage';
import { PluginConsent } from './PluginConsent';
import { PluginOffers } from './PluginOffers';
import { pluginAdditions, withoutPluginOffers } from './offers';
import { defaultPluginShelf, type InstalledPlugin, type PluginShelf } from './shelf';
import { sourceFromFolder, sourceFromUrl, sourceFromZip, type PluginSource } from './sources';

declare const APP_VERSION: string;

/**
 * Settings → Plugins (P10-T03, ADR-72): install from a folder, a zip or an address, behind the
 * consent screen; turn each on per character (ADR-55 amended); its own settings; remove, asking
 * whether to forget what it kept. Installing reaches nothing until the person picks or types a
 * source; downloads wait for consent and for a picture's first showing.
 */
export interface PluginsDeps {
  readonly shelf: PluginShelf;
  readonly assets: PluginAssets;
  readonly fetch: typeof fetch;
  /** The memory store to forget a plugin's data in; null when memory is off. */
  readonly memory: (settings: Settings) => Promise<MemoryStore | null>;
  readonly appVersion: string;
  /** P10-T07: the desktop shell's route to the companion's `mcp.json`, for a plugin's programs; null in a browser. */
  readonly companion: CompanionConfigApi | null;
  /** The person's IANA zone, where a plugin's schedule is read (ADR-58). */
  readonly timeZone: string;
  /** P10-T09: the plugin index, fetched only on Browse. */
  readonly indexUrl: string;
}

const windowFetch: typeof fetch = (input, init) => window.fetch(input, init);

export function defaultPluginsDeps(): PluginsDeps {
  return {
    shelf: defaultPluginShelf(),
    assets: new PluginAssets(),
    fetch: windowFetch,
    memory: async (settings) =>
      (await chooseMemoryStore({ setting: settings.memory, companionUrl: settings.companionUrl, fetch: windowFetch, indexedDB: globalThis.indexedDB }))?.store ?? null,
    appVersion: APP_VERSION,
    indexUrl: PLUGIN_INDEX_URL,
    companion: ((shell) => (shell === null ? null : companionConfigApi(shell.invoke)))(desktopShell()),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export interface PluginsSectionProps {
  readonly settings: Settings;
  readonly onChange: (update: (prev: Settings) => Settings) => void;
  readonly deps?: PluginsDeps;
}

interface Row {
  readonly info: InstalledPlugin;
  readonly loaded: LoadedPlugin;
}

/** Every installed plugin, each checked again as it loads. */
async function loadRows(deps: PluginsDeps): Promise<readonly Row[]> {
  const list = await deps.shelf.list();
  return Promise.all(list.map(async (info) => ({ info, loaded: await loadPlugin(deps.shelf, info.id, deps.appVersion) })));
}

/** The index's plugins, each with Read it (to the consent screen) and whether it is installed. */
function PluginIndexList({ index, installed, busy, onRead }: { readonly index: PluginIndexRead; readonly installed: readonly InstalledPlugin[]; readonly busy: boolean; readonly onRead: (entry: PluginIndexEntry) => void }): ReactElement {
  return (
    <div className="plugin-index">
      {index.plugins.length === 0 ? <p className="field-hint">The index lists no plugins yet.</p> : null}
      <ul aria-label="Plugins in the index" className="plugin-index-list">
        {index.plugins.map((entry) => {
          const have = installed.find((plugin) => plugin.id === entry.id);
          return (
            <li className="plugin-index-item" key={entry.id}>
              <div className="tools-server-title">
                <span className="tools-server-label">
                  {entry.name} {entry.version}
                </span>
                <span className="field-hint">{entry.summary}</span>
                <span className="field-hint">
                  {entry.author} · {entry.licence}
                  {entry.tags.length === 0 ? '' : ` · ${entry.tags.join(', ')}`}
                </span>
              </div>
              {have?.version === entry.version ? (
                <span className="pill">Installed</span>
              ) : (
                <button className="btn btn-ghost" disabled={busy} onClick={() => onRead(entry)} type="button">
                  {have === undefined ? 'Read it' : `Update from ${have.version}`}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {index.skipped > 0 ? <p className="field-hint">{index.skipped} more could not be read by this version of the app.</p> : null}
    </div>
  );
}

export function PluginsSection({ settings, onChange, deps: given }: PluginsSectionProps): ReactElement {
  const [deps] = useState(() => given ?? defaultPluginsDeps());
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [pending, setPending] = useState<Extract<PluginInspection, { ok: true }> | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [forget, setForget] = useState(false);
  // P10-T09 (ADR-72 item 9): the index, fetched only on the press.
  const [index, setIndex] = useState<PluginIndexRead | null>(null);
  const [browseProblem, setBrowseProblem] = useState<string | null>(null);
  const active = packFor(settings.character).persona;

  useEffect(() => {
    let cancelled = false;
    void loadRows(deps).then((loaded) => {
      if (!cancelled) setRows(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [deps]);

  const refresh = async () => setRows(await loadRows(deps));

  const read = async (load: () => Promise<PluginSource>) => {
    setBusy(true);
    setProblems([]);
    setPending(null);
    try {
      const inspection = await inspectPlugin(await load(), deps.appVersion);
      if (inspection.ok) setPending(inspection);
      else setProblems(inspection.problems);
    } catch (error) {
      setProblems([error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    setBusy(true);
    setBrowseProblem(null);
    try {
      setIndex(await fetchPluginIndex(deps.fetch, deps.indexUrl));
    } catch (error) {
      setBrowseProblem(`The list could not be fetched. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const onFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (files.length === 0) return;
    void read(() => sourceFromFolder(files.map((file) => ({ path: file.webkitRelativePath || file.name, bytes: async () => new Uint8Array(await file.arrayBuffer()) }))));
  };

  const onZip = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    void read(async () => sourceFromZip(file.name, new Uint8Array(await file.arrayBuffer())));
  };

  const install = async (enable: boolean) => {
    if (pending === null) return;
    const { id } = pending.facts;
    await installPlugin(pending, deps.shelf);
    if (enable) onChange((prev) => withPluginEnabled(prev, active.id, id, true));
    setPending(null);
    await refresh();
  };

  // P10-T07 (ADR-72 item 7): through the ordinary store, for one character, in the person's zone.
  const makeSchedule =
    settings.memory === 'off'
      ? null
      : async (characterId: string, request: ScheduleRequest): Promise<ScheduleResult> => {
          const store = await deps.memory(settings);
          if (store === null) return { ok: false, reason: 'Her memory could not be reached, so the schedule was not made.' };
          return new Schedules({ store, characterId, timeZone: deps.timeZone, companion: false }).create(request);
        };

  const remove = async (id: string) => {
    // What it added goes with it (ADR-72 item 7): its schedules, its programs, its servers and their grants.
    const loaded = rows.find((row) => row.info.id === id)?.loaded;
    const added = pluginAdditions(settings, loaded?.ok === true ? loaded.plugin.manifest : null, id);
    const needsStore = forget || added.schedules.length > 0;
    const store = needsStore ? await deps.memory(settings) : null;
    for (const { scheduleId } of added.schedules) await store?.deleteSchedule(scheduleId);
    if (added.programs) await deps.companion?.removePluginServers(id);
    await removePlugin(id, { shelf: deps.shelf, assets: deps.assets, ...(store === null || !forget ? {} : { forget: { store, characterIds: PACKS.map((pack) => pack.persona.id) } }) });
    onChange((prev) => withoutPluginOffers(withoutPlugin(prev, id), id));
    setRemoving(null);
    setForget(false);
    await refresh();
  };

  return (
    <section className="panel settings-section" id="settings-plugins">
      <div className="panel-header">
        <span className="panel-title">Plugins</span>
      </div>
      <p className="field-hint">
        Abilities someone packaged for her: a tarot deck, office tools. Each is turned on per character. A plugin runs no code in this page; what one may download or reach is shown
        before it is installed.
      </p>

      <div className="plugin-install">
        <label className="btn btn-ghost plugin-file">
          Install from a folder…
          <input aria-label="Plugin folder" className="plugin-file-input" disabled={busy} multiple onChange={onFolder} type="file" {...{ webkitdirectory: '' }} />
        </label>
        <label className="btn btn-ghost plugin-file">
          Install from a .zip…
          <input accept=".zip,application/zip" aria-label="Plugin zip file" className="plugin-file-input" disabled={busy} onChange={onZip} type="file" />
        </label>
      </div>
      <form
        className="plugin-address"
        onSubmit={(event) => {
          event.preventDefault();
          if (address.trim() !== '') void read(() => sourceFromUrl(address.trim(), deps.fetch));
        }}
      >
        <label className="field-label" htmlFor="plugin-address">
          Or its address
        </label>
        <div className="plugin-address-row">
          <input
            className="input"
            id="plugin-address"
            onChange={(event) => setAddress(event.target.value)}
            placeholder="https://…/plugin.json"
            type="url"
            value={address}
          />
          <button className="btn btn-ghost" disabled={busy || address.trim() === ''} type="submit">
            Read it
          </button>
        </div>
      </form>
      <div className="plugin-browse">
        <button className="btn btn-ghost" disabled={busy} onClick={() => void browse()} type="button">
          {index === null ? 'Browse plugins…' : 'Browse again'}
        </button>
        <span className="field-hint">Fetches the list from {new URL(deps.indexUrl).host}, only when you press it.</span>
      </div>
      {browseProblem === null ? null : (
        <p className="field-error" role="alert">
          {browseProblem}
        </p>
      )}
      {index === null ? null : (
        <PluginIndexList
          busy={busy}
          index={index}
          installed={rows.map((row) => row.info)}
          onRead={(entry) => void read(() => sourceFromIndex(entry, deps.fetch))}
        />
      )}
      {busy ? <p className="field-hint">Reading the plugin…</p> : null}

      {problems.length === 0 ? null : (
        <div className="plugin-problems" role="alert">
          <p className="field-error">It cannot be installed:</p>
          <ul>
            {problems.map((problem) => (
              <li className="field-error" key={problem}>
                {problem}
              </li>
            ))}
          </ul>
        </div>
      )}

      {pending === null ? null : (
        <PluginConsent
          characterName={active.name}
          facts={pending.facts}
          onCancel={() => setPending(null)}
          onInstall={(enable) => void install(enable)}
          replaces={rows.find((row) => row.info.id === pending.facts.id)?.info.version ?? null}
        />
      )}

      {budgetWarnings(rows, settings).map((warning) => (
        <p className="field-hint plugin-budget" key={warning} role="status">
          {warning}
        </p>
      ))}

      {rows.length === 0 ? (
        <p className="field-hint">No plugins installed.</p>
      ) : (
        <ul aria-label="Installed plugins" className="tools-server-list">
          {rows.map(({ info, loaded }) => (
            <li className="tools-server plugin-item" key={info.id}>
              <div className="tools-server-head">
                <div className="tools-server-title">
                  <span className="tools-server-label">
                    {info.name} {info.version}
                  </span>
                  <span className="field-hint">{info.summary}</span>
                </div>
                <button className="btn btn-ghost" onClick={() => setRemoving(removing === info.id ? null : info.id)} type="button">
                  Remove
                </button>
              </div>

              {loaded.ok ? (
                <>
                  <div className="plugin-characters">
                    {PACKS.map(({ persona }) => (
                      <label className="tools-switch" key={persona.id}>
                        <input
                          checked={enabledPlugins(settings, persona.id).includes(info.id)}
                          onChange={(event) => onChange((prev) => withPluginEnabled(prev, persona.id, info.id, event.target.checked))}
                          type="checkbox"
                        />
                        On for {persona.name}
                      </label>
                    ))}
                  </div>
                  <p className="field-hint">
                    About {loaded.plugin.promptTokens.idle + loaded.plugin.promptTokens.used} tokens in every request while it is on (an estimate); {loaded.plugin.promptTokens.idle} if it loads only when needed.
                  </p>
                  <label className="tools-switch">
                    <input checked={settings.lazyPlugins.includes(info.id)} onChange={(event) => onChange((prev) => withPluginLazy(prev, info.id, event.target.checked))} type="checkbox" />
                    Load only when needed: saves its {loaded.plugin.promptTokens.used} tokens until she uses it, but the first use is slower and small models use it less reliably
                  </label>
                  <PluginOffers companion={deps.companion} makeSchedule={makeSchedule} manifest={loaded.plugin.manifest} onChange={onChange} settings={settings} />
                  {Object.entries(loaded.plugin.manifest.settings).map(([key, setting]) => (
                    <PluginSettingField
                      id={`plugin-${info.id}-${key}`}
                      key={key}
                      onChange={(value) => onChange((prev) => withPluginSetting(prev, info.id, key, value))}
                      setting={setting}
                      value={settings.plugins[info.id]?.[key]}
                    />
                  ))}
                </>
              ) : (
                <div className="plugin-problems" role="alert">
                  <p className="field-error">It no longer passes its check, so it is off:</p>
                  <ul>
                    {loaded.problems.map((problem) => (
                      <li className="field-error" key={problem}>
                        {problem}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {removing === info.id ? (
                <div className="plugin-remove">
                  <label className="tools-switch">
                    <input checked={forget} onChange={(event) => setForget(event.target.checked)} type="checkbox" />
                    Also forget what it kept for each character
                  </label>
                  <div className="consent-actions">
                    <button className="btn btn-danger" onClick={() => void remove(info.id)} type="button">
                      Remove {info.name}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setRemoving(null)} type="button">
                      Keep it
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Each character's warnings, from the plugins turned on for them (ADR-72 item 4). */
function budgetWarnings(rows: readonly Row[], settings: Settings): string[] {
  return PACKS.flatMap(({ persona }) => {
    const on = enabledPlugins(settings, persona.id);
    const costs = rows.flatMap(({ info, loaded }) =>
      loaded.ok && on.includes(info.id)
        ? [{ name: info.name, tools: loaded.plugin.manifest.tools.length, promptTokens: loaded.plugin.promptTokens, always: !settings.lazyPlugins.includes(info.id) }]
        : [],
    );
    return costs.length === 0 ? [] : [...pluginBudget(costs, persona.name).warnings];
  });
}

function PluginSettingField({ id, setting, value, onChange }: { readonly id: string; readonly setting: PluginSetting; readonly value: JsonValue | undefined; readonly onChange: (value: JsonValue) => void }): ReactElement {
  if (setting.type === 'switch') {
    return (
      <label className="tools-switch">
        <input checked={typeof value === 'boolean' ? value : setting.default} id={id} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
        {setting.label}
      </label>
    );
  }
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {setting.label}
      </label>
      {setting.type === 'choice' ? (
        <select className="select" id={id} onChange={(event) => onChange(event.target.value)} value={typeof value === 'string' && setting.choices.includes(value) ? value : setting.default}>
          {setting.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      ) : setting.type === 'number' ? (
        <input
          className="input"
          id={id}
          max={setting.maximum}
          min={setting.minimum}
          onChange={(event) => {
            const number = Number(event.target.value);
            if (event.target.value !== '' && Number.isFinite(number)) onChange(number);
          }}
          type="number"
          value={typeof value === 'number' ? value : setting.default}
        />
      ) : (
        <input className="input" id={id} onChange={(event) => onChange(event.target.value)} value={typeof value === 'string' ? value : setting.default} />
      )}
    </div>
  );
}
