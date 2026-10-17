import { describe, expect, it } from 'vitest';
import type { HttpFetch } from '@latentpresence/providers/web';
import { checkCompanionDatabase, describeMemoryCheck } from './memory-check';

const answer = (body: unknown, status = 200): HttpFetch => (async () => new Response(JSON.stringify(body), { status })) as HttpFetch;
const healthy = (database: { kind: string; connected: boolean }) => ({ status: 'ok', service: 'latentpresence-companion', version: '0.0.0', database });

describe('checkCompanionDatabase (P8-T02)', () => {
  it('reads /health with the protocol schema', async () => {
    const check = (database: { kind: string; connected: boolean }) =>
      checkCompanionDatabase({ companionUrl: 'http://127.0.0.1:8787', fetch: answer(healthy(database)) });
    expect(await check({ kind: 'mariadb', connected: true })).toBe('connected');
    expect(await check({ kind: 'none', connected: false })).toBe('no-database');
    expect(await check({ kind: 'mariadb', connected: false })).toBe('database-down');
  });

  it('treats an error status, a stranger on the port and a refusal as not running', async () => {
    const options = { companionUrl: 'http://127.0.0.1:8787' };
    expect(await checkCompanionDatabase({ ...options, fetch: answer({}, 401) })).toBe('not-running');
    expect(await checkCompanionDatabase({ ...options, fetch: answer({ ...healthy({ kind: 'none', connected: false }), service: 'other' }) })).toBe('not-running');
    expect(
      await checkCompanionDatabase({
        ...options,
        fetch: (async () => {
          throw new TypeError('Failed to fetch');
        }) as HttpFetch,
      }),
    ).toBe('not-running');
  });

  it('gives up on a companion that never answers', async () => {
    const hang = ((_input: string | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as HttpFetch;
    expect(await checkCompanionDatabase({ companionUrl: 'http://127.0.0.1:8787', fetch: hang, timeoutMs: 20 })).toBe('not-running');
  });

  it('says what to do next for every outcome: in the app, the address field (ADR-62); elsewhere, .env and the companion', () => {
    for (const check of ['no-database', 'database-down', 'not-running'] as const) {
      const app = describeMemoryCheck(check, true, 'http://127.0.0.1:8790');
      const browser = describeMemoryCheck(check, false, 'http://127.0.0.1:8787');
      expect(app.tone, check).not.toBe('ok');
      expect(JSON.stringify(app), check).not.toMatch(/DATABASE_URL|environment variable/);
      expect(JSON.stringify(browser), check).not.toMatch(/quit the app/i);
    }
    expect(JSON.stringify(describeMemoryCheck('no-database', true, ''))).toMatch(/Save/);
    expect(JSON.stringify(describeMemoryCheck('database-down', true, ''))).toMatch(/Save it again/);
    expect(JSON.stringify(describeMemoryCheck('not-running', true, ''))).toMatch(/quit the app/i);
    expect(JSON.stringify(describeMemoryCheck('no-database', false, ''))).toMatch(/\.env/);
    expect(describeMemoryCheck('connected', false, '').tone).toBe('ok');
  });
});
