import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { splitToolName, transcriptToText, type TranscriptLine } from '@latentpresence/core';

/**
 * The transcript panel (P1-T11, `docs/ui/transcript.md`): a `log` region of `lines`, Copy
 * and Clear. Takes `lines` rather than a subscription — `useTranscript` does the folding —
 * so the same component sits on `/chat`, `/dev/voice`, and Phase 2's call screen.
 */
export interface TranscriptPanelProps {
  readonly lines: readonly TranscriptLine[];
  readonly characterName: string;
  readonly onClear: () => void;
  /**
   * P5-T04 (ADR-45): what a citation ref stands for, from the hits she was given. A ref this
   * does not know was never given to her, so it is shown as a source she made up.
   */
  readonly sources?: ((ref: string) => CitationSource | undefined) | undefined;
}

/** A chunk she was given and may cite: where it came from and what it said. */
export interface CitationSource {
  readonly title: string;
  readonly locator: string | null;
  readonly source: string;
  readonly text: string;
}

type Sources = TranscriptPanelProps['sources'];

type AssistantLine = Extract<TranscriptLine, { kind: 'assistant' }>;

/** How close to the bottom still counts as "at the bottom", in pixels — a reader who
 * scrolled up by even a little should not be yanked back down on the next token. */
const BOTTOM_SLACK_PX = 8;

function formatTime(at: string): string {
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** `412 ms`, or `1.2 s` at and above one second, per the note. */
function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function TranscriptBadges({ line }: { line: AssistantLine }): ReactElement | null {
  if (line.firstTokenMs === null && line.firstAudioMs === null) return null;
  return (
    <p className="transcript-badges">
      {line.firstTokenMs !== null && (
        <span className="transcript-badge" title="From the end of your turn to the first word of the answer">
          first word {formatMs(line.firstTokenMs)}
        </span>
      )}
      {line.firstAudioMs !== null && (
        <span className="transcript-badge" title="From the end of your turn to the first sound of it">
          first audio {formatMs(line.firstAudioMs)}
        </span>
      )}
    </p>
  );
}

/** The sources under an answer (P5-T04, ADR-45): numbered in the order first cited. */
function TranscriptSources({ citations, sources }: { citations: readonly string[]; sources: Sources }): ReactElement | null {
  if (citations.length === 0) return null;
  return (
    <div className="transcript-sources">
      <p className="transcript-sources-title">Sources</p>
      <ol className="transcript-source-list">
        {citations.map((ref, index) => {
          const found = sources?.(ref);
          if (found === undefined) {
            return (
              <li className="transcript-source transcript-source-unknown" key={ref}>
                {index + 1}. A source she was not given
              </li>
            );
          }
          const where = found.locator === null ? '' : `, ${found.locator}`;
          return (
            <li className="transcript-source" key={ref}>
              <details className="transcript-source-details">
                <summary>{`${index + 1}. ${found.title}${where}`}</summary>
                <blockquote className="transcript-source-quote">{found.text}</blockquote>
                <code className="transcript-source-path">{found.source}</code>
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TranscriptLineView({
  line,
  characterName,
  sources,
}: {
  line: TranscriptLine;
  characterName: string;
  sources: Sources;
}): ReactElement {
  if (line.kind === 'notice') {
    return (
      <p className="transcript-line transcript-line-notice">
        <span aria-hidden="true" className="transcript-notice-marker" />
        {line.text}
      </p>
    );
  }

  if (line.kind === 'tool') {
    // P5-T01 (ADR-42): every call that reached outside, said plainly.
    // Her own search of their documents (P5-T04) says what she did rather than a tool's name.
    if (line.name === 'documents_search') {
      return (
        <p className={`transcript-line transcript-line-tool transcript-line-tool-${line.state}`}>
          <span aria-hidden="true" className="transcript-tool-marker" />
          {line.state === 'running' && `${characterName} is looking in your documents…`}
          {line.state === 'done' && `${characterName} looked in your documents`}
          {line.state === 'failed' && `${characterName} could not look in your documents: ${line.detail ?? 'it failed'}`}
        </p>
      );
    }
    const { server, tool } = splitToolName(line.name);
    const what = server === null ? tool : `${server} · ${tool}`;
    return (
      <p className={`transcript-line transcript-line-tool transcript-line-tool-${line.state}`}>
        <span aria-hidden="true" className="transcript-tool-marker" />
        {line.state === 'running' && `${characterName} is using ${what}…`}
        {line.state === 'done' && `${characterName} used ${what}`}
        {line.state === 'failed' && `${characterName} did not use ${what}: ${line.detail ?? 'it failed'}`}
      </p>
    );
  }

  const isUser = line.kind === 'user';
  const streaming = line.kind === 'assistant' && line.status === 'streaming';
  const interrupted = line.kind === 'assistant' && line.status === 'interrupted';

  return (
    <div className={`transcript-line ${isUser ? 'transcript-line-user' : 'transcript-line-assistant'}`}>
      <p className="transcript-line-meta">
        <span className="transcript-line-name">{isUser ? 'You' : characterName}</span>
        <span className="transcript-line-time">{formatTime(line.at)}</span>
        {interrupted && <span className="pill pill-warn">interrupted</span>}
      </p>
      {/* A streaming line is its own live region, set `off`, so a token appended every few
          ms never announces; removing the override once it settles lets the ancestor
          `log` region (below) announce the finished line, per the note. */}
      <p aria-live={streaming ? 'off' : undefined} className="transcript-line-text">
        {interrupted ? (
          <>
            {line.heard}
            {/* A stopped chat reply has nothing unsaid; "(not said)" before nothing would be
                read aloud as if something were missing. */}
            {line.unsaid !== '' && (
              <span className="transcript-unsaid">
                <span className="transcript-sr-only">(not said) </span>
                {line.unsaid}
              </span>
            )}
          </>
        ) : (
          line.text
        )}
        {streaming && <span aria-hidden="true" className="transcript-cursor" />}
      </p>
      {line.kind === 'assistant' && <TranscriptSources citations={line.citations} sources={sources} />}
      {line.kind === 'assistant' && !streaming && <TranscriptBadges line={line} />}
    </div>
  );
}

export function TranscriptPanel({ lines, characterName, onClear, sources }: TranscriptPanelProps): ReactElement {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [pinned, setPinned] = useState(true);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el === null || !pinned || lines.length === 0) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, pinned]);

  useEffect(() => {
    if (copyStatus === 'idle') return;
    const id = window.setTimeout(() => setCopyStatus('idle'), 2000);
    return () => window.clearTimeout(id);
  }, [copyStatus]);

  function handleScroll(): void {
    const el = logRef.current;
    if (el === null) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX);
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(transcriptToText(lines, characterName));
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  }

  function jumpToLatest(): void {
    setPinned(true);
  }

  return (
    <section className="panel transcript-panel">
      <div className="panel-header">
        <span className="panel-title">Transcript</span>
        <div className="transcript-actions">
          <button className="btn btn-sm" onClick={() => void copy()} type="button">
            Copy transcript
          </button>
          <button className="btn btn-sm btn-ghost" onClick={onClear} type="button">
            Clear
          </button>
        </div>
      </div>

      <div aria-live="polite" className="transcript-status-region">
        {copyStatus === 'copied' && <span className="transcript-copy-status">Copied</span>}
        {copyStatus === 'failed' && <span className="transcript-copy-status transcript-copy-status-danger">Could not copy to the clipboard.</span>}
      </div>

      <div className="transcript-log-wrap">
        <div aria-live="polite" className="transcript-log" onScroll={handleScroll} ref={logRef} role="log">
          {lines.length === 0 && <p className="transcript-empty">Nothing said yet.</p>}
          {lines.map((line) => (
            <TranscriptLineView characterName={characterName} key={line.id} line={line} sources={sources} />
          ))}
        </div>
        {!pinned && (
          <button className="btn btn-sm transcript-jump" onClick={jumpToLatest} type="button">
            Jump to latest
          </button>
        )}
      </div>
    </section>
  );
}
