import { Suspense, lazy, useState, type ReactElement } from 'react';
import type { BodyShelf } from '../characters/body-shelf';
import type { CharacterShelf } from '../characters/character-shelf';
import type { CharacterDraft } from '../characters/edit';

/** The editor's rules arrive with the editor, not with Settings (ADR-68). */
const editRules = () => import('../characters/edit');
import type { Characters } from '../characters/packs';
import type { Removed } from '../characters/remove-character';
import type { CharacterSettings, TtsSettings } from './settings';
import { BROWSER_VOICE_GROUPS, languageLabel } from './VoiceSection';

/** The editor loads when it is opened: Settings stays inside its budget (ADR-68) for everyone else. */
const CharacterEditor = lazy(async () => ({ default: (await import('../characters/CharacterEditor')).CharacterEditor }));

export interface CharacterSectionProps {
  /** The active character's id. */
  readonly character: string;
  /** Everyone to choose from (P11-T01, ADR-74): Alice and Theo, then the person's own. */
  readonly list: Characters;
  readonly characters: Readonly<Record<string, CharacterSettings>>;
  /** The engine in use: a saved voice counts only for the engine it was chosen on. */
  readonly tts: TtsSettings;
  readonly onSelect: (id: string) => void;
  readonly onVoice: (id: string, voice: CharacterSettings['voice']) => void;
  /** Where their characters are kept (P11-T03): the editor saves here. */
  readonly shelf: CharacterShelf;
  /** Their own bodies, offered as a character's default body. */
  readonly bodyShelf: BodyShelf;
  /** Deletes one of theirs: its schedules, the shelf entry and its settings (ADR-74 item 7). */
  readonly onDelete: (id: string, forget: boolean) => Promise<Removed>;
}

/**
 * Who she is, and what she sounds like (P6-T06, ADR-55). The same choice as "Talking to" in
 * `/chat`, and the voice for the active character: on Kokoro a voice from the list, on a server
 * a voice id. No choice (`null`) is the persona's own voice on Kokoro, the one in Voice elsewhere.
 * Everything else in Settings stays the person's, not the character's.
 */
export function CharacterSection({ character, list, characters, tts, onSelect, onVoice, shelf, bodyShelf, onDelete }: CharacterSectionProps): ReactElement {
  const pack = list.packFor(character);
  // P11-T03 (ADR-74 item 5): the editor, open on one draft at a time, and the delete question.
  const [editing, setEditing] = useState<CharacterDraft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<string | null>(null);
  const { persona } = pack;
  const saved = characters[persona.id]?.voice ?? null;
  const savedHere = saved !== null && saved.kind === tts.kind ? saved : null;

  const open = async (make: (rules: Awaited<ReturnType<typeof editRules>>) => CharacterDraft): Promise<void> => {
    const draft = make(await editRules());
    setDeleting(false);
    setDeleted(null);
    setEditing(draft);
  };

  const save = async (draft: CharacterDraft): Promise<void> => {
    const createdAt = draft.id === null ? null : ((await shelf.list()).find((kept) => kept.persona.id === draft.id)?.createdAt ?? null);
    const stored = (await editRules()).storedOf({ ...draft, createdAt }, new Date());
    await shelf.put(stored);
    setEditing(null);
    onSelect(stored.persona.id);
  };

  const remove = async (forget: boolean): Promise<void> => {
    setDeleteProblem(null);
    const name = pack.persona.name;
    try {
      const removed = await onDelete(pack.persona.id, forget);
      const { removedWords } = await import('../characters/remove-character');
      setDeleting(false);
      setDeleted(removedWords(name, removed));
    } catch (error) {
      setDeleteProblem(`${name} could not be deleted (${error instanceof Error ? error.message : String(error)}), so nothing was. Try again.`);
    }
  };

  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Character</span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="settings-character">
          Talking to
        </label>
        <select className="select" id="settings-character" onChange={(event) => onSelect(event.target.value)} value={persona.id}>
          {list.packs.map((candidate) => (
            <option key={candidate.persona.id} value={candidate.persona.id}>
              {candidate.persona.name}
            </option>
          ))}
        </select>
      </div>
      <p className="field-hint">{persona.summary}</p>

      {editing === null ? (
        <div className="character-manage">
          {!pack.builtIn && (
            <button aria-label={`Edit ${persona.name}`} className="btn btn-sm" onClick={() => void open((rules) => rules.editDraft(pack, null))} type="button">
              Edit
            </button>
          )}
          <button aria-label={`Duplicate ${persona.name}`} className="btn btn-sm btn-ghost" onClick={() => void open((rules) => rules.duplicateDraft(pack))} type="button">
            Duplicate
          </button>
          {!pack.builtIn && (
            <button aria-label={`Delete ${persona.name}`} className="btn btn-sm btn-ghost" onClick={() => setDeleting(true)} type="button">
              Delete…
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => void open((rules) => rules.newDraft())} type="button">
            New character
          </button>
          {pack.builtIn && <span className="field-hint">{persona.name} comes with the app. Duplicate to make one of your own from them.</span>}
        </div>
      ) : (
        <Suspense fallback={<p className="field-hint">Opening the editor…</p>}>
          <CharacterEditor bodyShelf={bodyShelf} draft={editing} key={editing.id ?? `new:${editing.name}`} onCancel={() => setEditing(null)} onSave={save} />
        </Suspense>
      )}

      {deleting && editing === null && (
        <div aria-label={`Delete ${persona.name}`} className="character-delete" role="region">
          <p>
            Delete {persona.name}? Their schedules are deleted too. Kept, what they remember stays under their name, and importing them again brings it back. Forgotten, it is gone for good: every turn, fact, plan and note.
          </p>
          <div className="character-actions">
            <button className="btn btn-danger" onClick={() => void remove(false)} type="button">
              Delete, keeping what they remember
            </button>
            <button className="btn btn-danger" onClick={() => void remove(true)} type="button">
              Delete and forget everything
            </button>
            <button className="btn btn-ghost" onClick={() => setDeleting(false)} type="button">
              Keep them
            </button>
          </div>
          {deleteProblem !== null && (
            <p className="field-error" role="alert">
              {deleteProblem}
            </p>
          )}
        </div>
      )}
      {deleted !== null && (
        <p className="field-hint" role="status">
          {deleted}
        </p>
      )}

      <p className="field-hint">
        {persona.name}&apos;s body is chosen in the call, under Body: it changes while you talk.
      </p>

      <div className="field">
        <label className="field-label" htmlFor="settings-character-voice">
          Voice for {persona.name}
        </label>
        {tts.kind === 'kokoro-browser' ? (
          <select
            className="select"
            id="settings-character-voice"
            onChange={(event) => onVoice(persona.id, event.target.value === '' ? null : { kind: 'kokoro-browser', voiceId: event.target.value, speed: tts.speed })}
            value={savedHere?.voiceId ?? ''}
          >
            <option value="">
              {persona.name}&apos;s own ({persona.voice.voiceId})
            </option>
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
        ) : (
          <input
            className="input"
            id="settings-character-voice"
            onChange={(event) => {
              const voiceId = event.target.value.trim();
              onVoice(persona.id, voiceId === '' ? null : { kind: 'openai-compatible', voiceId, speed: tts.speed });
            }}
            placeholder="Blank: the voice in Voice"
            value={savedHere?.voiceId ?? ''}
          />
        )}
      </div>
      <p className="field-hint">
        {tts.kind === 'kokoro-browser'
          ? `Used while the voice is the browser's (Kokoro). Each character keeps their own.`
          : `Used while the voice is the OpenAI-compatible server. Blank means the voice chosen in Voice.`}
      </p>
    </section>
  );
}
