import { describeMemoryStoreConformance } from '@latentpresence/core/memory-conformance';
import { CompanionMemoryStore } from './companion';

/**
 * Runs the shared conformance suite against a real companion, over its MariaDB store
 * (P4-T04). `pnpm gate` has no companion running, so this skips whenever
 * `LP_TEST_COMPANION_URL` is unset rather than trying to start one or reach a database —
 * the architect runs it by hand against the dev MariaDB.
 */
// `src/` has no node types (only `live/` scripts do), so the environment is read through
// `globalThis` rather than `process` directly.
const companionUrl = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['LP_TEST_COMPANION_URL'];

describeMemoryStoreConformance({
  name: 'CompanionMemoryStore',
  create: () => new CompanionMemoryStore({ baseUrl: companionUrl ?? 'http://127.0.0.1:0' }),
  skip: companionUrl === undefined ? 'LP_TEST_COMPANION_URL is unset; set it to a running companion to run this suite' : null,
  vectors: true,
});
