import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { companionConfigApi, type CompanionConfigApi } from '../desktop/companion-config';
import { desktopShell } from '../desktop/desktop';
import { useCompanionConfig, type CompanionConfigOptions } from './companion-config-state';
import { CompanionSettings } from './CompanionSettings';
import { defaultSettingsDeps, type SettingsDeps } from './deps';
import { CharacterSection } from './CharacterSection';
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
}

export function SettingsPanel({ deps: depsOverride, companionConfig, listCompanion, homeWaitMs, homePollMs }: SettingsPanelProps = {}): ReactElement {
  const deps = useMemo<SettingsDeps>(() => ({ ...defaultSettingsDeps(), ...depsOverride }), [depsOverride]);
  const [settings, setSettings] = useState<Settings>(() => loadSettings(deps.storage));

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
        onSelect={(character) => setSettings((prev) => ({ ...prev, character }))}
        onVoice={(id, voice) => setSettings((prev) => ({ ...prev, characters: { ...prev.characters, [id]: { body: null, ...prev.characters[id], voice } } }))}
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

      {api !== null && <CompanionSettings controller={companion} />}

      <DocumentsSection
        companionUrl={settings.companionUrl}
        onSearchChange={(search) => setSettings((prev) => ({ ...prev, documents: { ...prev.documents, search } }))}
        search={settings.documents.search}
      />

      <DownloadedModelsSection caches={deps.caches} consent={deps.consent} />
    </div>
  );
}
