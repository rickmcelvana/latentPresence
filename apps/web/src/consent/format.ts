/** MB, one decimal — the unit the consent screen and the Downloaded models section both
 * show a size in (P1-T13's brief). */
export function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
