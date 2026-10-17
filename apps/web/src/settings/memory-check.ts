import { HealthResponseSchema } from '@latentpresence/protocol';
import { normaliseBaseUrl, type HttpFetch } from '@latentpresence/providers/web';
import type { ConnectionResult } from './connection';

/**
 * The wizard's "Check" for a MariaDB memory (P8-T02): `GET {companion}/health`, read with the
 * protocol's own schema. Unlike `chat-memory.ts`, which only needs a yes or no, this says *why*
 * not, because the person is standing in front of the step that fixes it.
 *
 * - `connected`: the companion has a database and reached it.
 * - `no-database`: the companion answered and has no `DATABASE_URL` (`database.kind` is `none`).
 * - `database-down`: it has one and could not connect (wrong address, server stopped, too old).
 * - `not-running`: nothing answered, or whatever answered was not the companion.
 */
export type MemoryCheck = 'connected' | 'no-database' | 'database-down' | 'not-running';

export const MEMORY_CHECK_TIMEOUT_MS = 3000;

export async function checkCompanionDatabase(options: {
  readonly companionUrl: string;
  readonly fetch: HttpFetch;
  readonly timeoutMs?: number;
}): Promise<MemoryCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MEMORY_CHECK_TIMEOUT_MS);
  try {
    const response = await options.fetch(`${normaliseBaseUrl(options.companionUrl)}/health`, { signal: controller.signal });
    if (!response.ok) return 'not-running';
    const health = HealthResponseSchema.safeParse(await response.json());
    if (!health.success) return 'not-running';
    if (health.data.database.connected) return 'connected';
    return health.data.database.kind === 'none' ? 'no-database' : 'database-down';
  } catch {
    return 'not-running';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What to tell the person about a check, and what to do next. `inApp` is the desktop app, where
 * the address is typed into the app itself (ADR-62) and saving it restarts the companion; elsewhere
 * they edit `.env` and start the companion themselves.
 * Command steps end in the command, which `ConnectionStatus` shows in `code`.
 */
export function describeMemoryCheck(check: MemoryCheck, inApp: boolean, companionUrl: string): ConnectionResult {
  switch (check) {
    case 'connected':
      return { tone: 'ok', text: 'Connected. The companion reached your MariaDB database.' };
    case 'no-database':
      return {
        tone: 'warn',
        text: inApp
          ? 'No database address is saved yet, so nothing is remembered.'
          : 'The companion is running but has no database address (DATABASE_URL), so nothing is remembered yet.',
        help: {
          summary: inApp ? 'No database address.' : 'No DATABASE_URL.',
          steps: inApp
            ? ['Type your database address above and press Save. The companion restarts with it.']
            : [
                'Put the DATABASE_URL line in the file named .env in the latentPresence folder.',
                'Stop the companion (Ctrl+C in its terminal), then start it again with pnpm companion',
                'Press Check again.',
              ],
        },
      };
    case 'database-down':
      return {
        tone: 'warn',
        text: 'The companion has a database address but could not connect to it, so nothing is remembered yet.',
        help: {
          summary: 'The database did not answer.',
          steps: [
            'Check that the MariaDB server is running and that you can reach it from this computer.',
            `Check the user name, password, host and database name in ${inApp ? 'the address' : 'DATABASE_URL'}.`,
            'It must be MariaDB 11.8 or newer.',
            inApp ? 'Fix the address above (Replace), then Save it again.' : 'Restart the companion, then press Check.',
          ],
        },
      };
    case 'not-running':
      return inApp
        ? {
            tone: 'danger',
            text: 'The companion did not answer. It starts with the app, so quit the app and open it again, then press Check.',
          }
        : {
            tone: 'danger',
            text: `The companion is not running at ${companionUrl}.`,
            help: {
              summary: 'The companion is not running.',
              steps: ['Open a terminal in the latentPresence folder and start it with pnpm companion', 'Leave it running, then press Check again.'],
            },
          };
  }
}
