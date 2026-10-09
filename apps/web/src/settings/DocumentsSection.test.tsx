import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestJob, IngestStatus } from '@latentpresence/protocol';
import type { CompanionIngest } from '@latentpresence/providers/web';
import { DocumentsSection } from './DocumentsSection';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DONE: IngestJob = {
  id: 'job-1',
  status: 'done',
  trigger: 'start',
  documentsSeen: 12,
  documentsIndexed: 10,
  documentsRemoved: 1,
  chunksWritten: 340,
  failures: [{ source: 'C:/docs/broken.pdf', error: 'not a PDF' }],
  startedAt: '2026-10-09T10:00:00.000Z',
  finishedAt: '2026-10-09T10:00:05.000Z',
  error: null,
};

const STATUS: IngestStatus = {
  folders: [
    { path: 'C:/docs/manuals', exists: true, documents: 11, chunks: 340 },
    { path: 'C:/docs/gone', exists: false, documents: 0, chunks: 0 },
  ],
  embedding: { provider: 'http://127.0.0.1:11434/v1', model: 'nomic-embed-text', dimensions: 768 },
  watching: true,
  job: DONE,
  configError: null,
};

function fakeIngest(overrides: Partial<CompanionIngest> = {}) {
  const calls = { status: 0, scan: 0, job: 0 };
  const ingest: CompanionIngest = {
    search: async () => ({ hits: [], vectorSearch: 'used' }),
    status: async () => {
      calls.status += 1;
      return STATUS;
    },
    scan: async () => {
      calls.scan += 1;
      return DONE;
    },
    job: async () => {
      calls.job += 1;
      return DONE;
    },
    ...overrides,
  };
  return { ingest, calls };
}

async function press(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

function scanDisabled(): boolean {
  return (screen.getByRole('button', { name: 'Scan now' }) as HTMLButtonElement).disabled;
}

describe('DocumentsSection (P5-T03, ADR-44)', () => {
  it('asks the companion nothing until a button is pressed', async () => {
    const { ingest, calls } = fakeIngest();
    render(<DocumentsSection companionUrl="http://localhost:8731" onSearchChange={() => {}} search={false} ingest={ingest} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toEqual({ status: 0, scan: 0, job: 0 });
    expect(screen.getByText(/nothing here\s+is sent anywhere/iu)).toBeTruthy();
  });

  it('has a switch, off by default, that writes search both ways and asks the companion nothing (P5-T04, ADR-45)', () => {
    const { ingest, calls } = fakeIngest();
    const onSearchChange = vi.fn();
    const { rerender } = render(<DocumentsSection companionUrl="http://localhost:8731" ingest={ingest} onSearchChange={onSearchChange} search={false} />);
    const off = screen.getByRole('switch', { name: 'Let her search these documents' }) as HTMLInputElement;
    expect(off.checked).toBe(false);
    fireEvent.click(off);
    expect(onSearchChange).toHaveBeenLastCalledWith(true);

    rerender(<DocumentsSection companionUrl="http://localhost:8731" ingest={ingest} onSearchChange={onSearchChange} search />);
    const on = screen.getByRole('switch', { name: 'Let her search these documents' }) as HTMLInputElement;
    expect(on.checked).toBe(true);
    fireEvent.click(on);
    expect(onSearchChange).toHaveBeenLastCalledWith(false);
    expect(calls).toEqual({ status: 0, scan: 0, job: 0 });
  });

  it('Check shows each folder, the embedding model, watching and the last job', async () => {
    const { ingest } = fakeIngest();
    render(<DocumentsSection companionUrl="http://localhost:8731" onSearchChange={() => {}} search={false} ingest={ingest} />);
    await press('Check');

    expect(screen.getByText('C:/docs/manuals')).toBeTruthy();
    expect(screen.getByText('11 documents · 340 chunks')).toBeTruthy();
    expect(screen.getByText('C:/docs/gone')).toBeTruthy();
    expect(screen.getByText('not found')).toBeTruthy();
    expect(screen.getByText(/Embedding with nomic-embed-text \(768 dimensions\)/u)).toBeTruthy();
    expect(screen.getByText(/Watching the folders/u)).toBeTruthy();
    expect(screen.getByText(/Last scan: done/u)).toBeTruthy();
    expect(screen.getByText('12 seen · 10 indexed · 1 removed · 340 chunks')).toBeTruthy();
    expect(screen.getByText('1 file could not be read')).toBeTruthy();
    expect(screen.getByText('C:/docs/broken.pdf — not a PDF')).toBeTruthy();
  });

  it('says keyword search only when there is no embedding model, and not watching', async () => {
    const { ingest } = fakeIngest({ status: async () => ({ ...STATUS, embedding: null, watching: false, job: null }) });
    render(<DocumentsSection companionUrl="http://localhost:8731" onSearchChange={() => {}} search={false} ingest={ingest} />);
    await press('Check');
    expect(screen.getByText(/Keyword search only/u)).toBeTruthy();
    expect(screen.getByText(/Not watching/u)).toBeTruthy();
    expect(screen.queryByText(/Last scan/u)).toBeNull();
  });

  it('shows the config error in the danger style, with no folders', async () => {
    const { ingest } = fakeIngest({ status: async () => ({ folders: [], embedding: null, watching: false, job: null, configError: 'unknown field "foo"' }) });
    render(<DocumentsSection companionUrl="http://localhost:8731" onSearchChange={() => {}} search={false} ingest={ingest} />);
    await press('Check');
    const error = screen.getByText('documents.json: unknown field "foo"');
    expect(error.className).toContain('settings-status-danger');
    expect(screen.getByText(/No folders yet/u)).toBeTruthy();
  });

  it('Scan now follows the job once a second until it is done, then stops', async () => {
    const running = (seen: number): IngestJob => ({ ...DONE, id: 'job-2', status: 'running', trigger: 'request', documentsSeen: seen, documentsIndexed: 0, documentsRemoved: 0, chunksWritten: 0, finishedAt: null, failures: [] });
    const reads: IngestJob[] = [running(4), { ...DONE, id: 'job-2', trigger: 'request', documentsSeen: 12 }];
    const { ingest, calls } = fakeIngest({
      scan: async () => running(1),
      job: async () => {
        calls.job += 1;
        return reads.shift() ?? DONE;
      },
    });
    render(<DocumentsSection companionUrl="http://localhost:8731" onSearchChange={() => {}} search={false} ingest={ingest} />);
    await press('Scan now');
    expect(screen.getByText(/Last scan: running…/u)).toBeTruthy();
    expect(screen.getByText('1 seen · 0 indexed · 0 removed · 0 chunks')).toBeTruthy();
    expect(scanDisabled()).toBe(true);
    expect(calls.job).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls.job).toBe(1);
    expect(screen.getByText('4 seen · 0 indexed · 0 removed · 0 chunks')).toBeTruthy();
    expect(scanDisabled()).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(calls.job).toBe(2);
    expect(screen.getByText(/Last scan: done/u)).toBeTruthy();
    expect(screen.getByText('12 seen · 10 indexed · 1 removed · 340 chunks')).toBeTruthy();
    expect(scanDisabled()).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls.job).toBe(2);
    expect(calls.status).toBe(1);
  });

  it('stops following a scan when Settings closes', async () => {
    const { ingest, calls } = fakeIngest({ scan: async () => ({ ...DONE, status: 'running', finishedAt: null }) });
    const { unmount } = render(<DocumentsSection companionUrl="http://localhost:8731" onSearchChange={() => {}} search={false} ingest={ingest} />);
    await press('Scan now');
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls.job).toBe(0);
  });

  it('a failed job shows its error', async () => {
    const failed: IngestJob = { ...DONE, status: 'failed', failures: [], error: 'the embedding endpoint refused: 401' };
    const { ingest } = fakeIngest({ scan: async () => failed });
    render(<DocumentsSection companionUrl="http://localhost:8731" onSearchChange={() => {}} search={false} ingest={ingest} />);
    await press('Scan now');
    expect(screen.getByText(/Last scan: failed/u).className).toContain('settings-status-danger');
    expect(screen.getByText('the embedding endpoint refused: 401')).toBeTruthy();
  });

  it('says so, with the pnpm companion advice, when the companion is not answering', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    render(<DocumentsSection companionUrl="http://localhost:8731" onSearchChange={() => {}} search={false} fetch={fetch as unknown as typeof globalThis.fetch} />);
    await press('Check');
    expect(screen.getByText(/the companion is not answering \(Failed to fetch\)/u).textContent).toContain('pnpm companion');
    expect(fetch).toHaveBeenCalledWith('http://localhost:8731/ingest/status', expect.objectContaining({ method: 'GET' }));
    await press('Scan now');
    expect(screen.getByText(/pnpm companion/u)).toBeTruthy();
    expect(scanDisabled()).toBe(false);
  });
});
