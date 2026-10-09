import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { companionIngest, type CompanionIngest } from '@latentpresence/providers/web';
import type { IngestJob, IngestStatus } from '@latentpresence/protocol';

/**
 * Settings → Documents (P5-T03, ADR-44): the folders the companion indexes so she can look
 * things up in them, and how the last scan went.
 *
 * **Nothing is asked of the companion until Check or Scan now is pressed**, and the page never
 * names a path: the folders are the ones in the companion's own `documents.json`, edited by
 * the person. Scan now posts a scan and follows the job once a second until it ends.
 */
export interface DocumentsSectionProps {
  /** Where the companion listens — the settings document's `companionUrl`. */
  readonly companionUrl: string;
  /** P5-T04, ADR-45: whether she may search the documents. Off by default; no unasked request. */
  readonly search: boolean;
  readonly onSearchChange: (search: boolean) => void;
  /** Test seam: what Check and Scan now ask. Omitted, the companion's real `/ingest/*`. */
  readonly ingest?: CompanionIngest | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Test seam: how often a running job is read. */
  readonly pollMs?: number | undefined;
}

const POLL_MS = 1000;

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.startsWith('the companion is not answering') ? `${text}; start it with "pnpm companion", then try again` : text;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function finishedText(job: IngestJob): string {
  return job.finishedAt === null ? '' : ` · finished ${new Date(job.finishedAt).toLocaleString()}`;
}

function JobSummary({ job }: { readonly job: IngestJob }): ReactElement {
  const running = job.status === 'queued' || job.status === 'running';
  const tone = job.status === 'done' ? 'ok' : job.status === 'failed' ? 'danger' : 'warn';
  return (
    <div className="ingest-job">
      <p className={`settings-status settings-status-${tone}`}>
        Last scan: {job.status}
        {running ? '…' : ''}
        {finishedText(job)}
      </p>
      <p className="ingest-job-counts">
        {job.documentsSeen} seen · {job.documentsIndexed} indexed · {job.documentsRemoved} removed · {job.chunksWritten} chunks
      </p>
      {job.error !== null && <p className="settings-status settings-status-danger">{job.error}</p>}
      {job.failures.length > 0 && (
        <details className="ingest-failures">
          <summary>{plural(job.failures.length, 'file could not be read', 'files could not be read')}</summary>
          <ul className="ingest-failure-list">
            {job.failures.map((failure, index) => (
              <li className="ingest-failure" key={`${index}:${failure.source}`}>
                {failure.source} — {failure.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function DocumentsSection({ companionUrl, search, onSearchChange, ingest, fetch, pollMs = POLL_MS }: DocumentsSectionProps): ReactElement {
  const [status, setStatus] = useState<IngestStatus | null>(null);
  const [job, setJob] = useState<IngestJob | null>(null);
  const [checking, setChecking] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on unmount, so a scan being followed stops reading when Settings closes.
  const run = useRef(0);

  useEffect(() => {
    run.current += 1;
    const mine = run.current;
    return () => {
      if (run.current === mine) run.current += 1;
    };
  }, []);

  function client(): CompanionIngest {
    return ingest ?? companionIngest({ baseUrl: companionUrl, ...(fetch === undefined ? {} : { fetch }) });
  }

  async function check(): Promise<void> {
    setChecking(true);
    setError(null);
    try {
      const next = await client().status();
      setStatus(next);
      setJob(next.job);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setChecking(false);
    }
  }

  async function scan(): Promise<void> {
    const mine = run.current;
    const alive = (): boolean => run.current === mine;
    setScanning(true);
    setError(null);
    try {
      const api = client();
      let current = await api.scan();
      if (!alive()) return;
      setJob(current);
      while (current.status === 'queued' || current.status === 'running') {
        await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
        if (!alive()) return;
        current = await api.job(current.id);
        if (!alive()) return;
        setJob(current);
      }
      // The folders' counts moved with the job; read them again once it ends.
      const next = await api.status();
      if (!alive()) return;
      setStatus(next);
    } catch (cause) {
      if (alive()) setError(describeError(cause));
    } finally {
      if (alive()) setScanning(false);
    }
  }

  return (
    <section className="panel settings-section">
      <div className="panel-header">
        <span className="panel-title">Documents</span>
      </div>
      <p className="panel-note">
        The companion indexes the folders listed in its own documents.json, on this computer, so she can look things up in them. Nothing here
        is sent anywhere.
      </p>

      <label className="tools-switch">
        <input checked={search} onChange={(event) => onSearchChange(event.target.checked)} role="switch" type="checkbox" />
        <span>Let her search these documents</span>
      </label>
      <p className="panel-note">
        Off until you turn this on. On, she can look things up here and cite what she found, and the page asks the companion on this computer
        whether it has documents.
      </p>

      <div className="settings-test-row">
        <button className="btn btn-sm" disabled={checking || scanning} onClick={() => void check()} type="button">
          Check
        </button>
        <button className="btn btn-sm" disabled={scanning} onClick={() => void scan()} type="button">
          Scan now
        </button>
      </div>

      <div aria-live="polite" className="settings-status-region">
        {checking && <p className="settings-status settings-status-warn">Checking…</p>}
        {error !== null && <p className="settings-status settings-status-danger">{error}</p>}
        {status?.configError != null && <p className="settings-status settings-status-danger">documents.json: {status.configError}</p>}
      </div>

      {status !== null && (
        <div className="ingest-status">
          {status.folders.length === 0 ? (
            <p className="panel-note">No folders yet. Add some to the companion&apos;s documents.json and restart it.</p>
          ) : (
            <ul className="ingest-folder-list">
              {status.folders.map((folder) => (
                <li className="ingest-folder" key={folder.path}>
                  <span className="ingest-folder-path">{folder.path}</span>
                  <p className="ingest-folder-counts">
                    {folder.exists
                      ? `${plural(folder.documents, 'document', 'documents')} · ${plural(folder.chunks, 'chunk', 'chunks')}`
                      : 'not found'}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="panel-note">
            {status.embedding === null ? 'Keyword search only.' : `Embedding with ${status.embedding.model} (${status.embedding.dimensions} dimensions).`}{' '}
            {status.watching ? 'Watching the folders for changes.' : 'Not watching for changes.'}
          </p>
        </div>
      )}

      {job !== null && <JobSummary job={job} />}
    </section>
  );
}
