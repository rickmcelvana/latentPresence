import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { companionConfigApi, type CompanionConfigApi } from '../desktop/companion-config';
import { desktopShell } from '../desktop/desktop';
import { useCompanionConfig, type CompanionConfigOptions } from './companion-config-state';
import { CompanionSection } from './CompanionSection';
import { CompanionSettings } from './CompanionSettings';
import { syncCloseToTray } from '../desktop/tray';
import { DesktopAppSection } from './DesktopAppSection';
import { defaultSettingsDeps, type SettingsDeps } from './deps';
import { CharacterSection } from './CharacterSection';
import { useCharacters } from '../characters/use-characters';
import { defaultBodyShelf, type BodyShelf } from '../characters/body-shelf';
import type { Removed } from '../characters/remove-character';
import type { MemoryStore } from '@latentpresence/protocol';
import { DownloadedModelsSection } from './DownloadedModelsSection';
import { HearingSection } from './HearingSection';
import { InitiativeSection } from './InitiativeSection';
import { LanguageModelSection } from './LanguageModelSection';
import { DocumentsSection } from './DocumentsSection';
import { MemorySection } from './MemorySection';
import { ToolsSection } from './ToolsSection';
import { VaultNote } from './VaultNote';
import { VoiceSection } from './VoiceSection';
import { loadSettings, saveSettings, type LlmSettings, type Settings, type SttSettings, type TtsSettings } from './settings';

/**
 * P10-T04: Settings → Plugins loads after the page draws. It brings the plugin checker and the
 * manifest schema, and with them the page went past its budget (ADR-68: 233.6 of 230 kB gzipped);
 * it sits below the fold, so nothing is lost by its arriving a moment later.
 */
const PluginsSection = lazy(async () => ({ default: (await import('../plugins/PluginsSection')).PluginsSection }));

/**
 * The settings content (P1-T10): Language model, Character, Voice, Hearing, Memory, Speaking up and Tools, plus the Companion
 * field the Language model section shows when it needs one. A bare component rather than
 * a page, so Phase 2 can mount it inside `.drawer` without dragging a page layout along.
 *
 * `deps` overrides the real fetch/probe/vault/clock/audio-context for a test; omitted
 * fields fall back to `defaultSettingsDeps()`, so a caller in production passes nothing.
 */
export interface SettingsPanelProps {
  readonly deps?: Partial<SettingsDeps>;
  /** The companion's own settings (P8-T06), desktop app only; the shell's own when omitted. A test passes a fake. */
  readonly companionConfig?: CompanionConfigApi;
  /** Test seam: what the Home Assistant state asks the companion. */
  readonly listCompanion?: CompanionConfigOptions['listCompanion'];
  readonly homeWaitMs?: number;
  readonly homePollMs?: number;
  /** Their own bodies, offered as a character's default (P11-T03). */
  readonly bodyShelf?: BodyShelf;
  /** The store a deleted character's schedules are deleted from; the one Settings → Memory chose when omitted. */
  readonly memoryFor?: (settings: Settings) => Promise<MemoryStore | null>;
}

/** Loaded only when a character is deleted: the stores are not Settings' to carry (ADR-68). */
async function chosenMemory(settings: Settings, fetch: SettingsDeps['fetch']): Promise<MemoryStore | null> {
  const { chooseMemoryStore } = await import('../chat/chat-memory');
  return (await chooseMemoryStore({ setting: settings.memory, companionUrl: settings.companionUrl, fetch, indexedDB: globalThis.indexedDB }))?.store ?? null;
}

export function SettingsPanel({ deps: depsOverride, companionConfig, listCompanion, homeWaitMs, homePollMs, bodyShelf, memoryFor }: SettingsPanelProps = {}): ReactElement {
  const deps = useMemo<SettingsDeps>(() => ({ ...defaultSettingsDeps(), ...depsOverride }), [depsOverride]);
  const [settings, setSettings] = useState<Settings>(() => loadSettings(deps.storage));
  const characters = useCharacters(deps.characters);
  const bodies = useMemo(() => bodyShelf ?? defaultBodyShelf(), [bodyShelf]);
  const deleteCharacter = async (id: string, forget: boolean): Promise<Removed> => {
    const store = await (memoryFor ?? ((given: Settings) => chosenMemory(given, deps.fetch)))(settings);
    // Loaded only now, with the store: Settings stays inside its budget (ADR-68).
    const [{ removeCharacter }, { withoutCharacter }] = await Promise.all([import('../characters/remove-character'), import('../characters/edit')]);
    const result = await removeCharacter(id, { shelf: deps.characters, memory: store, forget });
    setSettings((prev) => withoutCharacter(prev, id));
    return result;
  };

  useEffect(() => {
    saveSettings(settings, deps.storage);
  }, [settings, deps.storage]);

  // The companion's own settings exist only in the desktop app (the browser's companion is the person's own process).
  const shell = desktopShell();
  const api = useMemo(() => (shell === null ? null : (companionConfig ?? companionConfigApi(shell.invoke))), [shell, companionConfig]);
  const turnOn = useCallback((which: 'tools' | 'search'): void => {
    setSettings((prev) =>
      which === 'tools' ? { ...prev, tools: { ...prev.tools, companion: true } } : { ...prev, documents: { ...prev.documents, search: true } },
    );
  }, []);
  const switches = useMemo(
    () => ({ tools: settings.tools.companion, search: settings.documents.search, turnOn }),
    [settings.tools.companion, settings.documents.search, turnOn],
  );
  const companion = useCompanionConfig({ api, switches, companionUrl: settings.companionUrl, fetch: deps.fetch, listCompanion, waitMs: homeWaitMs, pollMs: homePollMs });

  function updateLlm(patch: Partial<LlmSettings>): void {
    setSettings((prev) => ({ ...prev, llm: { ...prev.llm, ...patch } }));
  }

  return (
    <div className="settings-sections">
      <VaultNote />

      <LanguageModelSection
        companionUrl={settings.companionUrl}
        deps={deps}
        llm={settings.llm}
        onChangeCompanionUrl={(companionUrl) => setSettings((prev) => ({ ...prev, companionUrl }))}
        onChangeLlm={updateLlm}
      />

      <CharacterSection
        character={settings.character}
        characters={settings.characters}
        list={characters}
        bodyShelf={bodies}
        onDelete={deleteCharacter}
        shelf={deps.characters}
        onSelect={(character) => setSettings((prev) => ({ ...prev, character }))}
        onVoice={(id, voice) => setSettings((prev) => ({ ...prev, characters: { ...prev.characters, [id]: { body: null, plugins: [], ...prev.characters[id], voice } } }))}
        tts={settings.tts}
      />

      <VoiceSection deps={deps} onChange={(tts: TtsSettings) => setSettings((prev) => ({ ...prev, tts }))} tts={settings.tts} />

      <HearingSection deps={deps} onChange={(stt: SttSettings) => setSettings((prev) => ({ ...prev, stt }))} stt={settings.stt} />

      <MemorySection
        companionUrl={settings.companionUrl}
        fetch={deps.fetch}
        memory={settings.memory}
        onChange={(memory) => setSettings((prev) => ({ ...prev, memory }))}
      />

      <InitiativeSection initiative={settings.initiative} onChange={(initiative) => setSettings((prev) => ({ ...prev, initiative }))} />

      <ToolsSection companionUrl={settings.companionUrl} onChange={(update) => setSettings((prev) => ({ ...prev, tools: update(prev.tools) }))} tools={settings.tools} vault={deps.vault} />

      <Suspense fallback={null}>
        <PluginsSection characters={characters} onChange={(update) => setSettings(update)} settings={settings} />
      </Suspense>

      {api !== null && <CompanionSettings controller={companion} />}

      {desktopShell() !== null && (
        <DesktopAppSection
          checkUpdates={settings.checkUpdates}
          closeToTray={settings.closeToTray}
          onCheckUpdatesChange={(checkUpdates) => setSettings((prev) => ({ ...prev, checkUpdates }))}
          onChange={(closeToTray) => {
            setSettings((prev) => ({ ...prev, closeToTray }));
            syncCloseToTray(closeToTray);
          }}
        />
      )}

      {/* In a browser the companion is the person's own `pnpm companion` (ADR-64). */}
      {desktopShell() === null && (
        <CompanionSection
          companionUrl={settings.companionUrl}
          fetch={deps.fetch}
          onChangeCompanionUrl={(companionUrl) => setSettings((prev) => ({ ...prev, companionUrl }))}
          origin={deps.origin}
          probe={deps.probe}
          storage={deps.storage}
        />
      )}

      <DocumentsSection
        companionUrl={settings.companionUrl}
        onSearchChange={(search) => setSettings((prev) => ({ ...prev, documents: { ...prev.documents, search } }))}
        search={settings.documents.search}
      />

      <DownloadedModelsSection caches={deps.caches} consent={deps.consent} />
    </div>
  );
}
