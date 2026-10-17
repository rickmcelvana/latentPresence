import type { ReactElement } from 'react';
import { PACKS } from '../characters/packs';
import { AVATAR_DESCRIPTOR } from '../call/character-asset';
import { ConsentScreen } from '../consent/ConsentScreen';

/** What the person has said about downloading the character's body. */
export type BodyChoice = 'unset' | 'agreed' | 'declined';

export interface CharacterStepProps {
  readonly character: string;
  readonly onSelect: (id: string) => void;
  readonly body: BodyChoice;
  readonly onBody: (choice: BodyChoice) => void;
}

/** One line of a persona's summary: its first sentence. */
function firstSentence(summary: string): string {
  const end = summary.search(/[.!?](\s|$)/);
  return end === -1 ? summary : summary.slice(0, end + 1);
}

/**
 * Step 3 (P8-T02): who she is, and the consent for her body. Agreeing records it in `ModelConsent`
 * (the caller does); nothing is fetched here, and "Not now" is fine: `/chat` asks again.
 */
export function CharacterStep({ character, onSelect, body, onBody }: CharacterStepProps): ReactElement {
  return (
    <>
      <fieldset className="welcome-choices">
        <legend className="field-label">Who do you want to talk to?</legend>
        {PACKS.map(({ persona }) => {
          const selected = persona.id === character;
          return (
            <label className={`welcome-choice ${selected ? 'welcome-choice-selected' : ''}`} key={persona.id}>
              <input checked={selected} name="welcome-character" onChange={() => onSelect(persona.id)} type="radio" value={persona.id} />
              <span className="welcome-choice-body">
                <span className="welcome-choice-title">{persona.name}</span>
                <span className="field-hint">{firstSentence(persona.summary)}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <p className="field-hint">You can change who you talk to at any time, in Chat or in Settings.</p>

      {body === 'unset' && (
        <ConsentScreen
          agreeLabel="Show the character"
          cancelLabel="Not now"
          descriptors={[AVATAR_DESCRIPTOR]}
          heading="This will download the character"
          intro="This comes from GitHub to this computer. It stays on this computer; nothing is sent anywhere. It downloads the first time you open Chat, not now."
          onAgree={() => onBody('agreed')}
          onCancel={() => onBody('declined')}
        />
      )}
      {body === 'agreed' && (
        <p className="welcome-note">
          <span className="pill pill-ok">Agreed</span> The character downloads the first time you open Chat.
        </p>
      )}
      {body === 'declined' && (
        <div className="welcome-note">
          <p className="field-hint">Not now. Chat asks again when you start, and you can still talk without seeing her.</p>
          <button className="btn btn-sm" onClick={() => onBody('unset')} type="button">
            Choose again
          </button>
        </div>
      )}
    </>
  );
}
