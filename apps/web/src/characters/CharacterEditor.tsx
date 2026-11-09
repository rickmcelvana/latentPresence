import { useEffect, useId, useState, type ReactElement } from 'react';
import { BROWSER_VOICE_GROUPS, languageLabel } from '../settings/VoiceSection';
import { BUILT_IN_BODIES } from './bodies';
import type { BodyShelf, OwnBody } from './body-shelf';
import { CLAIMS_HUMAN_WARNING, PERSONA_LIMITS, claimsHuman, draftProblems, draftTokens, type CharacterDraft } from './edit';

export interface CharacterEditorProps {
  readonly draft: CharacterDraft;
  /** Their own `.vrm` bodies, offered beside the built-in ones as the default body. */
  readonly bodyShelf: BodyShelf;
  /** Saves it; a rejection is shown as it is. */
  readonly onSave: (draft: CharacterDraft) => Promise<void>;
  readonly onCancel: () => void;
}

const GESTURES: readonly { readonly value: CharacterDraft['gestures']; readonly label: string; readonly hint: string }[] = [
  { value: 'rare', label: 'Rarely', hint: 'A few times in a conversation.' },
  { value: 'some', label: 'Sometimes', hint: 'Where a person naturally would.' },
  { value: 'often', label: 'Often', hint: 'Most replies, like an animated talker.' },
];

/** One list of short lines (how they talk, what they will not do): add, edit and take out, twelve at most. */
function LineList({ label, hint, lines, onChange }: { readonly label: string; readonly hint: string; readonly lines: readonly string[]; readonly onChange: (lines: readonly string[]) => void }): ReactElement {
  const full = lines.length >= PERSONA_LIMITS.lines;
  return (
    <fieldset className="character-lines">
      <legend className="field-label">{label}</legend>
      <p className="field-hint">{hint}</p>
      <ol className="character-line-list">
        {lines.map((line, index) => {
          const over = line.trim().length > PERSONA_LIMITS.line;
          return (
            // Lines have no identity of their own; the index is what the person sees ("line 3").
            // eslint-disable-next-line react/no-array-index-key
            <li className="character-line" key={index}>
              <div className="character-line-row">
                <input
                  aria-invalid={over}
                  aria-label={`${label}, line ${index + 1}`}
                  className="input"
                  onChange={(event) => onChange(lines.map((other, at) => (at === index ? event.target.value : other)))}
                  value={line}
                />
                <button aria-label={`Take out line ${index + 1} of ${label.toLowerCase()}`} className="btn btn-sm btn-ghost" onClick={() => onChange(lines.filter((_, at) => at !== index))} type="button">
                  Take out
                </button>
              </div>
              {over && (
                <p className="field-error">
                  {line.trim().length} characters; the most is {PERSONA_LIMITS.line}.
                </p>
              )}
              {claimsHuman(line) && <p className="character-warning">{CLAIMS_HUMAN_WARNING}</p>}
            </li>
          );
        })}
      </ol>
      <div className="character-line-add">
        <button className="btn btn-sm" disabled={full} onClick={() => onChange([...lines, ''])} type="button">
          Add a line
        </button>
        <span className="field-hint">
          {lines.length} of {PERSONA_LIMITS.lines} lines{full ? ': that is the most.' : '.'}
        </span>
      </div>
    </fieldset>
  );
}

/**
 * Making or editing a character (P11-T03, ADR-74 item 5): the persona in its own terms, every limit
 * beside its field, a warning on any line telling them to claim to be human (P11-T02), and what the
 * persona costs in every request. Problems stop the save and are said in sentences.
 */
export function CharacterEditor({ draft: initial, bodyShelf, onSave, onCancel }: CharacterEditorProps): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState<CharacterDraft>(initial);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [own, setOwn] = useState<readonly OwnBody[]>([]);
  const update = (patch: Partial<CharacterDraft>): void => setDraft((previous) => ({ ...previous, ...patch }));

  useEffect(() => {
    let live = true;
    bodyShelf.list().then(
      (bodies) => live && setOwn(bodies),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [bodyShelf]);

  const save = async (): Promise<void> => {
    const found = draftProblems(draft);
    setProblems(found);
    if (found.length > 0) return;
    setSaving(true);
    try {
      await onSave(draft);
    } catch (error) {
      setProblems([`It could not be saved: ${error instanceof Error ? error.message : String(error)}`]);
      setSaving(false);
    }
  };

  const heading = initial.id === null ? (initial.name === '' ? 'New character' : `New character from ${initial.name.replace(/ \(copy\)$/u, '')}`) : `Edit ${initial.name}`;
  const summaryLength = draft.summary.trim().length;

  return (
    <section aria-label={heading} className="character-editor">
      <h3 className="character-editor-title">{heading}</h3>

      <div className="field">
        <label className="field-label" htmlFor={`${id}-name`}>
          Name
        </label>
        <input aria-invalid={draft.name.trim().length > PERSONA_LIMITS.name} className="input" id={`${id}-name`} onChange={(event) => update({ name: event.target.value })} value={draft.name} />
        <span className="field-hint">Up to {PERSONA_LIMITS.name} characters. Shown in the call; renaming keeps everything they remember.</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor={`${id}-summary`}>
          Who they are
        </label>
        <textarea aria-invalid={summaryLength > PERSONA_LIMITS.summary} className="textarea" id={`${id}-summary`} onChange={(event) => update({ summary: event.target.value })} rows={5} value={draft.summary} />
        <span className="field-hint">
          One paragraph, read by the model every turn: {summaryLength.toLocaleString('en')} of {PERSONA_LIMITS.summary.toLocaleString('en')} characters.
        </span>
        {claimsHuman(draft.summary) && <p className="character-warning">{CLAIMS_HUMAN_WARNING}</p>}
      </div>

      <LineList
        hint={`Short orders work best, like "Answer first, explain second." Up to ${PERSONA_LIMITS.lines} lines of ${PERSONA_LIMITS.line} characters.`}
        label="How they talk"
        lines={draft.style}
        onChange={(style) => update({ style })}
      />
      <LineList
        hint="At least one. The app puts one of its own first: when someone sincerely asks, they say they are an AI."
        label="What they will not do"
        lines={draft.boundaries}
        onChange={(boundaries) => update({ boundaries })}
      />

      <div className="character-editor-row">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-voice`}>
            Voice
          </label>
          <select className="select" id={`${id}-voice`} onChange={(event) => update({ voiceId: event.target.value })} value={draft.voiceId}>
            {BROWSER_VOICE_GROUPS.map(({ language, voices }) => (
              <optgroup key={language} label={languageLabel(language)}>
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="field-hint">The browser&apos;s voice (Kokoro); heard in the next call.</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-speed`}>
            Speed
          </label>
          <div className="settings-speed-row">
            <input id={`${id}-speed`} max={1.25} min={0.75} onChange={(event) => update({ speed: Number(event.target.value) })} step={0.05} type="range" value={draft.speed} />
            <span className="field-hint">{draft.speed.toFixed(2)}×</span>
          </div>
        </div>
      </div>

      <div className="character-editor-row">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-gestures`}>
            Gestures
          </label>
          <select className="select" id={`${id}-gestures`} onChange={(event) => update({ gestures: event.target.value as CharacterDraft['gestures'] })} value={draft.gestures}>
            {GESTURES.map((gesture) => (
              <option key={gesture.value} value={gesture.value}>
                {gesture.label}
              </option>
            ))}
          </select>
          <span className="field-hint">{GESTURES.find((gesture) => gesture.value === draft.gestures)?.hint}</span>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-body`}>
            Body
          </label>
          <select className="select" id={`${id}-body`} onChange={(event) => update({ defaultBody: event.target.value })} value={draft.defaultBody}>
            {BUILT_IN_BODIES.map((body) => (
              <option key={body.id} value={body.id}>
                {body.name}
              </option>
            ))}
            {own.map((body) => (
              <option key={body.id} value={body.id}>
                {body.name} (your own)
              </option>
            ))}
          </select>
          <span className="field-hint">Worn when nothing else is chosen in the call, under Body.</span>
        </div>
      </div>

      <p className="character-cost">About {draftTokens(draft).toLocaleString('en')} tokens in every request (an estimate): the whole character is sent with each turn.</p>

      {problems.length > 0 && (
        <div role="alert">
          <ul aria-label="What stops it being saved" className="character-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="character-actions">
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()} type="button">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-ghost" disabled={saving} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </section>
  );
}
