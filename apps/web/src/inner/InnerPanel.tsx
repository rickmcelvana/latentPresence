import { useCallback, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { AttachedInner, InnerMoment } from '@latentpresence/core';

/**
 * The Thoughts panel (P6-T05, ADR-54): a peek at what was on her mind behind each answer. Her
 * lines are put into words by the page's own model only while this panel is open; what the
 * model reasoned before answering, when it did, is there too, folded away. Nothing here is ever
 * said aloud, shown in the transcript or remembered.
 */
export interface InnerPanelProps {
  /** Null before the page has attached her inner monologue. */
  readonly inner: AttachedInner | null;
  readonly characterName: string;
}

const NONE: readonly InnerMoment[] = [];

/** `18:04`, in the person's own time. */
function clock(at: string): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function short(text: string): string {
  return text.length <= 90 ? text : `${text.slice(0, 89).trimEnd()}…`;
}

function Moment({ moment, characterName }: { moment: InnerMoment; characterName: string }): ReactElement {
  return (
    <li className="inner-moment">
      <span className="inner-after">
        {clock(moment.at)} · {moment.heard === null ? `when ${characterName} spoke first` : 'after'} “{short(moment.said)}”
      </span>
      {moment.state === 'ready' &&
        moment.lines.map((line, index) => (
          <p className="inner-line" key={index}>
            {line}
          </p>
        ))}
      {moment.state === 'thinking' && <p className="inner-state">Putting it into words…</p>}
      {moment.state === 'unread' && <p className="inner-state">Not put into words — this panel was closed.</p>}
      {moment.state === 'failed' && <p className="inner-state">Nothing came of it this time.</p>}
      {moment.reasoning !== '' && (
        <details className="inner-reasoning">
          <summary>What the model reasoned before {characterName} answered</summary>
          <p className="inner-reasoning-text">{moment.reasoning}</p>
        </details>
      )}
    </li>
  );
}

export function InnerPanel({ inner, characterName }: InnerPanelProps): ReactElement {
  const subscribe = useCallback((listener: () => void) => inner?.subscribe(listener) ?? (() => undefined), [inner]);
  const getSnapshot = useCallback(() => inner?.moments() ?? NONE, [inner]);
  const moments = useSyncExternalStore(subscribe, getSnapshot);

  return (
    <section className="panel inner-panel">
      <div className="panel-header">
        <span className="panel-title">Thoughts</span>
      </div>
      <p className="panel-note">
        {characterName}'s private thoughts behind each answer — never said aloud, never remembered. Your model puts them into words while this is open.
      </p>
      <div className="inner-body">
        {moments.length === 0 ? (
          <p className="inner-empty">Nothing yet. When {characterName} answers, what was on her mind shows here.</p>
        ) : (
          <ol className="inner-list">
            {moments.toReversed().map((moment) => (
              <Moment characterName={characterName} key={moment.id} moment={moment} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
