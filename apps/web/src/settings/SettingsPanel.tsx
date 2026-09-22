import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { defaultSettingsDeps, type SettingsDeps } from './deps';
import { DownloadedModelsSection } from './DownloadedModelsSection';
import { HearingSection } from './HearingSection';
import { LanguageModelSection } from './LanguageModelSection';
import { VoiceSection } from './VoiceSection';
import { loadSettings, saveSettings, type LlmSettings, type Settings, type SttSettings, type TtsSettings } from './settings';

/**
 * The settings content (P1-T10): Language model, Voice and Hearing, plus the Companion
 * field the Language model section shows when it needs one. A bare component rather than
 * a page, so Phase 2 can mount it inside `.drawer` without dragging a page layout along.
 *
 * `deps` overrides the real fetch/probe/vault/clock/audio-context for a test; omitted
 * fields fall back to `defaultSettingsDeps()`, so a caller in production passes nothing.
 */
export interface SettingsPanelProps {
  readonly deps?: Partial<SettingsDeps>;
}

export function SettingsPanel({ deps: depsOverride }: SettingsPanelProps = {}): ReactElement {
  const deps = useMemo<SettingsDeps>(() => ({ ...defaultSettingsDeps(), ...depsOverride }), [depsOverride]);
  const [settings, setSettings] = useState<Settings>(() => loadSettings(deps.storage));

  useEffect(() => {
    saveSettings(settings, deps.storage);
  }, [settings, deps.storage]);

  function updateLlm(patch: Partial<LlmSettings>): void {
    setSettings((prev) => ({ ...prev, llm: { ...prev.llm, ...patch } }));
  }

  return (
    <div className="settings-sections">
      <p className="panel-note settings-vault-note">
        Keys are encrypted in this browser&apos;s storage. Anything running on this page, or anyone using this
        browser profile, can still use them.
      </p>

      <LanguageModelSection
        companionUrl={settings.companionUrl}
        deps={deps}
        llm={settings.llm}
        onChangeCompanionUrl={(companionUrl) => setSettings((prev) => ({ ...prev, companionUrl }))}
        onChangeLlm={updateLlm}
      />

      <VoiceSection deps={deps} onChange={(tts: TtsSettings) => setSettings((prev) => ({ ...prev, tts }))} tts={settings.tts} />

      <HearingSection deps={deps} onChange={(stt: SttSettings) => setSettings((prev) => ({ ...prev, stt }))} stt={settings.stt} />

      <DownloadedModelsSection caches={deps.caches} consent={deps.consent} />
    </div>
  );
}
