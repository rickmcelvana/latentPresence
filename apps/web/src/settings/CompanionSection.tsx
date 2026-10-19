import { useState } from 'react';
import type { ReactElement } from 'react';
import { addressSpaceOf, normaliseBaseUrl, probeEndpoint, type EndpointProbe, type HttpFetch } from '@latentpresence/providers/web';
import { loadPairingCode, normalisePairingCode, savePairingCode } from './companion-pairing';
import { COMPANION_NEEDS_PAIRING, messageForProbe, type ConnectionResult } from './connection';
import { ConnectionStatus } from './ConnectionStatus';

/**
 * Settings → Companion, in a browser (P8-T03, ADR-64): where the companion listens and, on the
 * hosted app, its pairing code. The desktop app's companion is its own (ADR-60), so this is not
 * shown there.
 *
 * The code is asked for only when this page is not on this computer: a companion answers pages
 * on this computer without one. Check asks `/health` once and says which of the usual things
 * stands in the way — nothing running, the browser asking or blocking, or the code.
 */
export interface CompanionSectionProps {
  readonly companionUrl: string;
  readonly onChangeCompanionUrl: (url: string) => void;
  readonly origin: string;
  readonly fetch: HttpFetch;
  readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Test seam: what Check asks. */
  readonly probe?: typeof probeEndpoint | undefined;
}

/** Whether a page at `origin` must pair: anything not on this computer. */
export function pageNeedsPairing(origin: string): boolean {
  return addressSpaceOf(origin) !== 'loopback';
}

export function companionCheckMessage(probe: EndpointProbe, url: string, origin: string, hasCode: boolean): ConnectionResult {
  if (probe.kind === 'answered' && probe.status === 401) {
    return hasCode
      ? { tone: 'danger', text: 'The companion refused this pairing code. Copy it again from the window the companion runs in, and save it.' }
      : { tone: 'warn', text: COMPANION_NEEDS_PAIRING };
  }
  if (probe.kind === 'answered' && probe.status === 200) return { tone: 'ok', text: 'Connected.' };
  if (probe.kind === 'unreachable') {
    return { tone: 'danger', text: `Nothing is answering at ${url}. Start it from a terminal in the latentPresence folder with pnpm companion, and leave it running.` };
  }
  return messageForProbe(probe, { endpointId: 'companion', label: 'the companion', url, origin, hasKey: false });
}

export function CompanionSection({ companionUrl, onChangeCompanionUrl, origin, fetch, storage, probe = probeEndpoint }: CompanionSectionProps): ReactElement {
  const [saved, setSaved] = useState<string | null>(() => loadPairingCode(storage));
  const [draft, setDraft] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ConnectionResult | null>(null);
  const pairing = pageNeedsPairing(origin);
  const typing = saved === null || replacing;

  async function check(): Promise<void> {
    setPending(true);
    setResult(null);
    const url = normaliseBaseUrl(companionUrl);
    const answer = await probe(`${url}/health`, { fetch });
    setResult(companionCheckMessage(answer, url, origin, loadPairingCode(storage) !== null));
    setPending(false);
  }

  function save(): void {
    if (normalisePairingCode(draft) === '') return;
    savePairingCode(storage, draft);
    setSaved(loadPairingCode(storage));
    setDraft('');
    setReplacing(false);
    void check();
  }

  function forget(): void {
    savePairingCode(storage, null);
    setSaved(null);
    setReplacing(false);
    setResult(null);
  }

  return (
    <section aria-label="Companion" className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Companion</span>
      </div>
      <p className="panel-note">
        An optional program on this computer: her memory in your own database, her tools, and the documents she can search. Start it
        from a terminal in the latentPresence folder with <code>pnpm companion</code>.
      </p>
      <div className="field">
        <label className="field-label" htmlFor="settings-companion-address">
          Address
        </label>
        <input className="input" id="settings-companion-address" onChange={(event) => onChangeCompanionUrl(event.target.value)} value={companionUrl} />
      </div>
      {pairing && (
        <div className="field">
          <label className="field-label" htmlFor="settings-companion-pairing">
            Pairing code
          </label>
          {typing ? (
            <div className="settings-key-row">
              <input
                autoComplete="off"
                className="input"
                id="settings-companion-pairing"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') save();
                }}
                placeholder="ABCD-EFGH-…"
                type="password"
                value={draft}
              />
              <button className="btn btn-sm" disabled={normalisePairingCode(draft) === ''} onClick={save} type="button">
                Save
              </button>
              {replacing && (
                <button className="btn btn-sm btn-ghost" onClick={() => setReplacing(false)} type="button">
                  Cancel
                </button>
              )}
            </div>
          ) : (
            <div className="settings-key-row">
              <span className="pill pill-ok">Saved in this browser</span>
              <button className="btn btn-sm" onClick={() => setReplacing(true)} type="button">
                Replace
              </button>
              <button className="btn btn-sm btn-danger" onClick={forget} type="button">
                Forget
              </button>
            </div>
          )}
          <span className="field-hint">
            The companion prints it when it starts. It answers this site only with the code; pages on this computer need none.
          </span>
        </div>
      )}
      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={pending} onClick={() => void check()} type="button">
          Check
        </button>
        <ConnectionStatus pending={pending} result={result} />
      </div>
    </section>
  );
}
