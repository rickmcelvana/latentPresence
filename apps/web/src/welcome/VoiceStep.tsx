import type { ReactElement } from 'react';
import type { ModelDescriptor } from '@latentpresence/protocol';
import { ConsentScreen } from '../consent/ConsentScreen';
import { DeviceCheck } from './DeviceCheck';
import type { WizardDevices } from './devices';

/** What the person has said about the voice and hearing models. */
export type VoiceChoice = 'unset' | 'agreed' | 'declined';

export interface VoiceStepProps {
  readonly models: readonly ModelDescriptor[];
  readonly voice: VoiceChoice;
  readonly onVoice: (choice: VoiceChoice) => void;
  readonly devices: WizardDevices;
  readonly inApp: boolean;
}

/**
 * Step 5 (P8-T02): voice and hearing. The consent screen for what `browserModelsFor` lists, then,
 * once they agreed, a microphone check and an optional camera check. Nothing downloads here and
 * no device starts until a button is pressed.
 */
export function VoiceStep({ models, voice, onVoice, devices, inApp }: VoiceStepProps): ReactElement {
  return (
    <>
      <p className="welcome-lead">
        Talking out loud uses small AI models that run on this computer: one to hear you, one to speak, and a few that notice
        when you have finished a sentence. If you would rather type, you can skip this and she will answer in text.
      </p>

      {voice === 'unset' && (
        <ConsentScreen
          agreeLabel="Agree"
          cancelLabel="Not now (text only)"
          descriptors={models}
          heading="These will download the first time you use voice"
          onAgree={() => onVoice('agreed')}
          onCancel={() => onVoice('declined')}
        />
      )}

      {voice === 'declined' && (
        <div className="welcome-note">
          <p className="field-hint">Text only for now. You can turn voice on later in Settings, or here.</p>
          <button className="btn btn-sm" onClick={() => onVoice('unset')} type="button">
            Choose again
          </button>
        </div>
      )}

      {voice === 'agreed' && (
        <>
          <p className="welcome-note">
            <span className="pill pill-ok">Agreed</span> The models download the first time you start a spoken call.
          </p>
          <section className="welcome-detail">
            <h2 className="welcome-subheading">Check your microphone</h2>
            <p className="field-hint">The microphone only turns on when you press the button, for a few seconds.</p>
            <DeviceCheck devices={devices} inApp={inApp} kind="microphone" />
          </section>
          <section className="welcome-detail">
            <h2 className="welcome-subheading">Check your camera (optional)</h2>
            <p className="field-hint">
              The camera is only used for &ldquo;Read my face&rdquo;, which is off until you turn it on. You can skip this.
            </p>
            <DeviceCheck devices={devices} inApp={inApp} kind="camera" />
          </section>
        </>
      )}
    </>
  );
}
