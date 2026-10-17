/**
 * Whether the first-run wizard (P8-T02) has been finished or skipped, readable without loading
 * the settings module.
 *
 * `App.tsx` decides at `/` between the boot screen and the wizard, and it is in the entry chunk:
 * importing `settings.ts` there would pull the provider package and the Kokoro voice list
 * (about 220 kB) into the first load for the sake of one boolean. This file imports nothing.
 *
 * It must agree with `loadSettings(...).welcomed` (`settings.ts`, `markWelcomed`); `welcomed.test.ts`
 * checks that across documents. The one place they can differ is a document that fails the schema:
 * `loadSettings` falls back to the defaults, this reads the field it can see.
 */

export const SETTINGS_STORAGE_KEY = 'latentpresence.settings.v1';

export function isWelcomed(storage: Pick<Storage, 'getItem'> = window.localStorage): boolean {
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return false;
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== 'object' || stored === null) return false;
    if ('welcomed' in stored) return stored.welcomed === true;
    // Saved before the wizard: set up already if a model was chosen.
    const llm = 'llm' in stored ? stored.llm : null;
    return typeof llm === 'object' && llm !== null && 'modelId' in llm && llm.modelId !== null && llm.modelId !== undefined;
  } catch {
    return false;
  }
}
