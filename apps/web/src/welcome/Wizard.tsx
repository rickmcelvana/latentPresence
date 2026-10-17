import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { AVATAR_DESCRIPTOR } from '../call/character-asset';
import { packFor } from '../characters/packs';
import { desktopShell } from '../desktop/desktop';
import { defaultSettingsDeps, type SettingsDeps } from '../settings/deps';
import { LanguageModelSection } from '../settings/LanguageModelSection';
import { endpointLabel } from '../settings/llm-endpoint';
import { loadSettings, saveSettings, type LlmSettings, type MemorySetting, type Settings } from '../settings/settings';
import { VaultNote } from '../settings/VaultNote';
import { browserModelsFor } from '../voice/models';
import { CharacterStep, type BodyChoice } from './CharacterStep';
import { defaultDevices, type WizardDevices } from './devices';
import { MemoryStep } from './MemoryStep';
import { VoiceStep, type VoiceChoice } from './VoiceStep';

/** Where "Start talking" and "Skip setup" go. */
const CHAT_ROUTE = '/chat';

const STEPS = ['welcome', 'model', 'character', 'memory', 'voice', 'done'] as const;
type StepId = (typeof STEPS)[number];

const TITLES: Record<StepId, string> = {
  welcome: 'Welcome to latentPresence',
  model: 'Choose a language model',
  character: 'Choose who you talk to',
  memory: 'Choose where she remembers',
  voice: 'Voice and hearing',
  done: 'You are ready',
};

const MEMORY_LABELS: Record<MemorySetting, string> = {
  browser: 'On this computer',
  companion: 'A MariaDB server',
  auto: 'Automatic (set in Settings)',
  off: "Doesn't remember",
};

export interface WizardProps {
  /** Overrides the real storage, vault, fetch and consent; omitted fields use `defaultSettingsDeps()`. */
  readonly deps?: Partial<SettingsDeps>;
  /** Overrides the microphone, camera and level meter. */
  readonly devices?: Partial<WizardDevices>;
  /** Where the page goes when setup ends. Defaults to a real navigation. */
  readonly navigate?: (path: string) => void;
  /** Start on this step (0 is the welcome). */
  readonly initialStep?: number;
}

function isLocalHost(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * The first-run wizard (P8-T02): provider, character, memory, voice and hearing, one step on
 * screen at a time. It saves each choice as it is made, so closing the window halfway loses
 * nothing; it records consent and downloads nothing; and it opens a microphone or camera only
 * when a button is pressed.
 */
export function Wizard({ deps: depsOverride, devices: devicesOverride, navigate, initialStep = 0 }: WizardProps = {}): ReactElement {
  const deps = useMemo<SettingsDeps>(() => ({ ...defaultSettingsDeps(), ...depsOverride }), [depsOverride]);
  const devices = useMemo<WizardDevices>(() => ({ ...defaultDevices(), ...devicesOverride }), [devicesOverride]);
  const inApp = desktopShell() !== null;
  const hosted = !isLocalHost(deps.origin);
  const go = navigate ?? ((path: string) => window.location.assign(path));

  const [settings, setSettings] = useState<Settings>(() => loadSettings(deps.storage));
  // Read through a ref so two changes in one event (a preset picked, then its URL) both land.
  const latest = useRef(settings);
  const [step, setStep] = useState(Math.min(Math.max(initialStep, 0), STEPS.length - 1));
  const [body, setBody] = useState<BodyChoice>(() => (deps.consent.has([AVATAR_DESCRIPTOR]) ? 'agreed' : 'unset'));
  const voiceModels = browserModelsFor(settings);
  const [voice, setVoice] = useState<VoiceChoice>(() => (deps.consent.has(browserModelsFor(settings)) ? 'agreed' : 'unset'));

  // The heading is remounted per step (`key`), and this ref callback focuses each new one, so a
  // step change puts focus on its heading. Not on the first render: that would steal the page's focus.
  const focusHeadings = useRef(false);
  useEffect(() => {
    focusHeadings.current = true;
  }, []);
  const focusHeading = useCallback((element: HTMLHeadingElement | null) => {
    if (element !== null && focusHeadings.current) element.focus();
  }, []);

  function commit(update: (previous: Settings) => Settings): void {
    const next = update(latest.current);
    latest.current = next;
    saveSettings(next, deps.storage);
    setSettings(next);
  }

  function finish(): void {
    commit((previous) => ({ ...previous, welcomed: true }));
    go(CHAT_ROUTE);
  }

  function agreeBody(choice: BodyChoice): void {
    if (choice === 'agreed') deps.consent.grant([AVATAR_DESCRIPTOR]);
    setBody(choice);
  }

  function agreeVoice(choice: VoiceChoice): void {
    if (choice === 'agreed') deps.consent.grant(voiceModels);
    setVoice(choice);
  }

  const id = STEPS[step] ?? 'welcome';
  const modelChosen = settings.llm.endpoint !== null && settings.llm.modelId !== null;
  const last = step === STEPS.length - 1;

  let content: ReactNode;
  switch (id) {
    case 'welcome':
      content = (
        <>
          <p className="welcome-lead">
            In latentPresence you talk with a character, by typing or out loud, who has a face and a voice, like a video call.
          </p>
          <p className="welcome-lead">
            She runs on AI models <strong>you</strong> choose. This app ships none. Nothing leaves this computer unless you point
            it somewhere yourself.
          </p>
          <p className="field-hint">Setup takes a few minutes. Every step can be changed later in Settings.</p>
          <div className="welcome-actions">
            <button className="btn btn-primary" onClick={() => setStep(1)} type="button">
              Set up
            </button>
            <button className="btn btn-ghost" onClick={finish} type="button">
              Skip setup
            </button>
          </div>
        </>
      );
      break;
    case 'model':
      content = (
        <>
          <p className="welcome-lead">
            Running Ollama or LM Studio on this computer? Choose it. Otherwise choose a cloud provider and paste its key.
          </p>
          <VaultNote />
          <LanguageModelSection
            companionUrl={settings.companionUrl}
            deps={deps}
            llm={settings.llm}
            onChangeCompanionUrl={(companionUrl) => commit((previous) => ({ ...previous, companionUrl }))}
            onChangeLlm={(patch: Partial<LlmSettings>) => commit((previous) => ({ ...previous, llm: { ...previous.llm, ...patch } }))}
          />
        </>
      );
      break;
    case 'character':
      content = (
        <CharacterStep
          body={body}
          character={packFor(settings.character).persona.id}
          onBody={agreeBody}
          onSelect={(character) => commit((previous) => ({ ...previous, character }))}
        />
      );
      break;
    case 'memory':
      content = (
        <MemoryStep
          companionUrl={settings.companionUrl}
          fetch={deps.fetch}
          hosted={hosted}
          inApp={inApp}
          memory={settings.memory}
          onChange={(memory) => commit((previous) => ({ ...previous, memory }))}
        />
      );
      break;
    case 'voice':
      content = <VoiceStep devices={devices} inApp={inApp} models={voiceModels} onVoice={agreeVoice} voice={voice} />;
      break;
    case 'done':
      content = (
        <Summary
          body={body}
          model={modelChosen ? `${endpointLabel(settings.llm.endpoint ?? '')}, ${settings.llm.modelId ?? ''}` : null}
          onGo={setStep}
          settings={settings}
          voice={voice}
        />
      );
      break;
  }

  return (
    <section aria-labelledby="welcome-heading" className="welcome-step">
      <p className="welcome-progress">
        {step + 1} of {STEPS.length}
      </p>
      <h1 className="welcome-heading" id="welcome-heading" key={id} ref={focusHeading} tabIndex={-1}>
        {TITLES[id]}
      </h1>

      {content}

      {id !== 'welcome' && (
        <div className="welcome-nav">
          <button className="btn btn-ghost" onClick={() => setStep(step - 1)} type="button">
            Back
          </button>
          <span className="welcome-nav-spacer" />
          {last ? (
            <button className="btn btn-primary" onClick={finish} type="button">
              Start talking
            </button>
          ) : (
            <>
              {id === 'model' && !modelChosen && (
                <button className="btn btn-ghost" onClick={() => setStep(step + 1)} type="button">
                  Skip for now
                </button>
              )}
              {id === 'voice' && voice === 'unset' && (
                <button className="btn btn-ghost" onClick={() => setStep(step + 1)} type="button">
                  Skip for now
                </button>
              )}
              <button
                className="btn btn-primary"
                disabled={(id === 'model' && !modelChosen) || (id === 'voice' && voice === 'unset')}
                onClick={() => setStep(step + 1)}
                type="button"
              >
                Next
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

interface SummaryProps {
  readonly settings: Settings;
  /** "Provider, model" when one is chosen, otherwise null. */
  readonly model: string | null;
  readonly body: BodyChoice;
  readonly voice: VoiceChoice;
  readonly onGo: (step: number) => void;
}

/** Step 6: what was chosen, and a way back to anything skipped. */
function Summary({ settings, model, body, voice, onGo }: SummaryProps): ReactElement {
  const rows: { label: string; value: string; fix: { step: number; label: string } | null }[] = [
    {
      label: 'Language model',
      value: model ?? 'None chosen yet. She cannot answer until you choose one.',
      fix: model === null ? { step: 1, label: 'Choose a language model' } : null,
    },
    {
      label: 'Character',
      value:
        packFor(settings.character).persona.name +
        (body === 'agreed' ? ', shown on screen.' : ', not shown yet. Chat asks again when you start.'),
      fix: body === 'agreed' ? null : { step: 2, label: 'Show the character' },
    },
    {
      label: 'Memory',
      value:
        MEMORY_LABELS[settings.memory] +
        (settings.memory === 'companion' ? '. Nothing is remembered while the companion has no database.' : '.'),
      fix: settings.memory === 'companion' ? { step: 3, label: 'Check the database' } : null,
    },
    {
      label: 'Voice and hearing',
      value: voice === 'agreed' ? 'On. The models download the first time you speak.' : 'Text only for now.',
      fix: voice === 'agreed' ? null : { step: 4, label: 'Set up voice' },
    },
  ];

  return (
    <>
      <ul className="welcome-summary">
        {rows.map((row) => (
          <li className="welcome-summary-row" key={row.label}>
            <span className="field-label">{row.label}</span>
            <span>{row.value}</span>
            {row.fix !== null && (
              <button className="btn btn-sm btn-ghost" onClick={() => onGo(row.fix?.step ?? 0)} type="button">
                {row.fix.label}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="field-hint">Everything here can be changed later in Settings.</p>
    </>
  );
}
