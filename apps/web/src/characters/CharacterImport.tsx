import { useMemo, useState, type ReactElement } from 'react';
import type { CharacterShelf } from './character-shelf';
import type { Characters } from './packs';
import { importedCharacter, readCharacterFile } from './share';

export interface CharacterImportProps {
  /** The picked file's name and text. */
  readonly fileName: string;
  readonly text: string;
  readonly list: Characters;
  readonly shelf: CharacterShelf;
  /** Added: the id it is kept under, and what to say. */
  readonly onAdded: (id: string, words: string) => void;
  readonly onCancel: () => void;
}

function lines(count: number): string {
  return count === 1 ? 'one line' : `${count} lines`;
}

/**
 * A character file before it is added (P11-T05, ADR-74 item 9): what is wrong with it in
 * sentences, or who it is and what it costs every turn, and what happens to its id.
 */
export function CharacterImport({ fileName, text, list, shelf, onAdded, onCancel }: CharacterImportProps): ReactElement {
  const read = useMemo(() => readCharacterFile(text, list), [text, list]);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (!read.ok) {
    return (
      <div aria-label={`Import ${fileName}`} className="character-import" role="region">
        <p>{fileName} cannot be imported.</p>
        <div role="alert">
          <ul aria-label="What is wrong with this file" className="character-problems">
            {read.problems.map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        </div>
        <div className="character-actions">
          <button className="btn btn-ghost" onClick={onCancel} type="button">
            Close
          </button>
        </div>
      </div>
    );
  }

  const { persona, fate, here } = read;
  const add = async (choice: 'keep' | 'replace' | 'new'): Promise<void> => {
    setProblem(null);
    setAdding(true);
    try {
      const existing = choice === 'replace' ? ((await shelf.list()).find((kept) => kept.persona.id === persona.id) ?? null) : null;
      const stored = importedCharacter(read, choice, { list, existing, now: new Date() });
      await shelf.put(stored);
      const name = stored.persona.name;
      onAdded(
        stored.persona.id,
        choice === 'replace' ? `${name} was replaced from the file; what they remember is kept.` : choice === 'keep' ? `${name} was added. Anything they remembered here before is theirs again.` : `${name} was added as a new character.`,
      );
    } catch (error) {
      setProblem(`${persona.name} could not be added (${error instanceof Error ? error.message : String(error)}). Nothing changed.`);
      setAdding(false);
    }
  };
  const tokens = Math.ceil([persona.name, persona.summary, ...persona.style, ...persona.boundaries].join('\n').length / 4);

  return (
    <div aria-label={`Import ${persona.name}`} className="character-import" role="region">
      <p className="character-import-name">{persona.name}</p>
      <p className="field-hint">{persona.summary}</p>
      <p className="field-hint">
        {lines(persona.style.length)} of how they talk, {lines(persona.boundaries.length)} of what they will not do: about {tokens.toLocaleString('en')} tokens in every request.
      </p>
      {read.warnings.map((warning) => (
        <p className="character-warning" key={warning}>
          {warning}
        </p>
      ))}
      {fate === 'new-only' && (
        <p>{here?.builtIn ? `This file has ${here.persona.name}'s id, who comes with the app, so it comes in as a new character, remembering nothing.` : 'This file has an id this app would not make, so it comes in as a new character, remembering nothing.'}</p>
      )}
      {fate === 'taken' && here !== null && <p>You already have {here.persona.name} under this file&apos;s id. Replace them with the file, keeping what they remember, or add the file as a new character.</p>}
      <div className="character-actions">
        {fate === 'free' && (
          <button className="btn btn-primary" disabled={adding} onClick={() => void add('keep')} type="button">
            Add {persona.name}
          </button>
        )}
        {fate === 'taken' && here !== null && (
          <button className="btn btn-primary" disabled={adding} onClick={() => void add('replace')} type="button">
            Replace {here.persona.name}, keeping what they remember
          </button>
        )}
        {fate !== 'free' && (
          <button className={fate === 'new-only' ? 'btn btn-primary' : 'btn'} disabled={adding} onClick={() => void add('new')} type="button">
            Add as a new character
          </button>
        )}
        <button className="btn btn-ghost" disabled={adding} onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
      {problem !== null && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
