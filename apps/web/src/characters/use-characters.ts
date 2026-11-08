import { useEffect, useMemo, useState } from 'react';
import type { CharacterShelf, StoredCharacter } from './character-shelf';
import { charactersFrom, type Characters } from './packs';

/**
 * The characters the page lists (P11-T01, ADR-74): Alice and Theo at once, the person's own as soon
 * as the shelf has been read, and again after every change to it, so the call's switcher, Settings
 * and the wizard all follow an edit. A shelf that cannot be read leaves the built-ins, ready.
 */
export function useCharacters(shelf: CharacterShelf): Characters {
  const [own, setOwn] = useState<readonly StoredCharacter[] | null>(null);

  useEffect(() => {
    let live = true;
    const read = (): void => {
      shelf.list().then(
        (characters) => live && setOwn(characters),
        () => live && setOwn((previous) => previous ?? []),
      );
    };
    read();
    const stop = shelf.subscribe(read);
    return () => {
      live = false;
      stop();
    };
  }, [shelf]);

  return useMemo(() => charactersFrom(own), [own]);
}
