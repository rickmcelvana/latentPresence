import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { factLine, MemoryStoreError, type AttachedMemory } from '@latentpresence/core';
import { EPISODE_PAGE_SIZE, type ConversationEvent, type MemoryEpisode, type SemanticFact } from '@latentpresence/protocol';

/**
 * The memory browser (P4-T05, ADR-39): a person's own view of what one character
 * remembers of them, and the only place they can correct or forget it. Everything here
 * reads and writes through `AttachedMemory` (`kernel` for the reads, its own methods for
 * the edits) — never a second path to the store.
 */
export interface MemoryPanelProps {
  readonly memory: AttachedMemory | null;
  /** Where it is kept ("this browser", "the companion at …"), or null with `memory`. */
  readonly where: string | null;
  readonly characterName: string;
  /**
   * The page's conversation bus (`ConversationMachine`, structurally): "what she was told
   * last" changes with every exchange, and `lastInjected()` itself is a plain synchronous
   * read with nothing to subscribe to on its own — this is what tells the panel to read it
   * again. Optional so a story or a stray render without a machine still works.
   */
  readonly subscribe?: (listener: (event: ConversationEvent) => void) => () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof MemoryStoreError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Surest first, then most recently learned — the same order `promptFacts` gives the rest of the note. */
function byConfidence(a: SemanticFact, b: SemanticFact): number {
  return b.confidence - a.confidence || Date.parse(b.recordedAt) - Date.parse(a.recordedAt);
}

/** `2026-09-20 14:32`, from an ISO timestamp. Deterministic and good enough for a browser of one's own memory. */
function formatWhen(at: string): string {
  const date = new Date(at);
  const day = date.toISOString().slice(0, 10);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

interface FactRowUi {
  readonly editing: boolean;
  readonly value: string;
  readonly confirming: boolean;
  readonly busy: boolean;
}

const DEFAULT_FACT_UI: FactRowUi = { editing: false, value: '', confirming: false, busy: false };

interface EpisodeRowUi {
  readonly confirming: boolean;
  readonly busy: boolean;
}

const DEFAULT_EPISODE_UI: EpisodeRowUi = { confirming: false, busy: false };

interface EpisodeGroup {
  readonly sessionId: string;
  readonly firstAt: string;
  readonly episodes: readonly MemoryEpisode[];
}

/** `episodes` newest first (as `listEpisodes` and the merged pages give them), grouped by
 * session, each group headed by the earliest turn it holds among what is loaded. Groups
 * keep the order their first (most recent) turn appears in, which is newest-session-first. */
function groupBySession(episodes: readonly MemoryEpisode[]): EpisodeGroup[] {
  const order: string[] = [];
  const bySession = new Map<string, MemoryEpisode[]>();
  for (const episode of episodes) {
    if (!bySession.has(episode.sessionId)) {
      order.push(episode.sessionId);
      bySession.set(episode.sessionId, []);
    }
    bySession.get(episode.sessionId)?.push(episode);
  }
  return order.map((sessionId) => {
    const group = bySession.get(sessionId) ?? [];
    const firstAt = group.reduce((earliest, episode) => (Date.parse(episode.at) < Date.parse(earliest) ? episode.at : earliest), group[0]?.at ?? '');
    return { sessionId, firstAt, episodes: group };
  });
}

function EpisodeRow({
  episode,
  characterName,
  ui,
  onDelete,
  onConfirmChange,
}: {
  episode: MemoryEpisode;
  characterName: string;
  ui: EpisodeRowUi;
  onDelete: (id: string) => void;
  onConfirmChange: (id: string, confirming: boolean) => void;
}): ReactElement {
  return (
    <div className="memory-episode-row">
      <p className="memory-episode-meta">
        <span className="memory-episode-speaker">{episode.role === 'user' ? 'You' : characterName}</span>
        <span className="memory-episode-time">{formatWhen(episode.at)}</span>
        {episode.interrupted && <span className="pill pill-warn">interrupted</span>}
      </p>
      <p className="memory-episode-text">{episode.text}</p>
      {ui.confirming ? (
        <div className="memory-confirm">
          <span>Forget this for good?</span>
          <button className="btn btn-sm btn-danger" disabled={ui.busy} onClick={() => onDelete(episode.id)} type="button">
            {ui.busy ? 'Forgetting…' : 'Confirm'}
          </button>
          <button className="btn btn-sm btn-ghost" disabled={ui.busy} onClick={() => onConfirmChange(episode.id, false)} type="button">
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn btn-sm btn-ghost" onClick={() => onConfirmChange(episode.id, true)} type="button">
          Delete
        </button>
      )}
    </div>
  );
}

export function MemoryPanel({ memory, where, characterName, subscribe }: MemoryPanelProps): ReactElement {
  // Bumped on every assistant message so "what she was told last" — a synchronous read
  // with nothing of its own to subscribe to — is re-read at the moments that can change it.
  const [injectedTick, setInjectedTick] = useState(0);

  const [facts, setFacts] = useState<readonly SemanticFact[]>([]);
  const [factsLoading, setFactsLoading] = useState(false);
  const [factsError, setFactsError] = useState<string | null>(null);
  const [factUi, setFactUi] = useState<Record<string, FactRowUi>>({});

  const [episodes, setEpisodes] = useState<readonly MemoryEpisode[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const [episodeUi, setEpisodeUi] = useState<Record<string, EpisodeRowUi>>({});

  const [searchInput, setSearchInput] = useState('');
  const [activeSearch, setActiveSearch] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<readonly MemoryEpisode[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);

  const factRow = useCallback((id: string): FactRowUi => factUi[id] ?? DEFAULT_FACT_UI, [factUi]);
  const episodeRow = useCallback((id: string): EpisodeRowUi => episodeUi[id] ?? DEFAULT_EPISODE_UI, [episodeUi]);

  const loadFacts = useCallback(() => {
    if (memory === null) return;
    setFactsLoading(true);
    setFactsError(null);
    memory.kernel
      .knownFacts()
      .then((loaded) => setFacts([...loaded].toSorted(byConfidence)))
      .catch((error: unknown) => setFactsError(messageOf(error)))
      .finally(() => setFactsLoading(false));
  }, [memory]);

  const loadEpisodes = useCallback(
    (before: string | null) => {
      if (memory === null) return;
      const first = before === null;
      if (first) setEpisodesLoading(true);
      else setOlderBusy(true);
      setEpisodesError(null);
      memory.kernel
        .listEpisodes(before)
        .then((page) => {
          setHasMore(page.length === EPISODE_PAGE_SIZE);
          setEpisodes((current) => {
            const merged = first ? page : [...current, ...page];
            const seen = new Set<string>();
            return merged.filter((episode) => (seen.has(episode.id) ? false : (seen.add(episode.id), true))).toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
          });
        })
        .catch((error: unknown) => setEpisodesError(messageOf(error)))
        .finally(() => (first ? setEpisodesLoading(false) : setOlderBusy(false)));
    },
    [memory],
  );

  // Mounts fresh whenever this view of the drawer opens — loading here, not at page load.
  useEffect(() => {
    if (memory === null) return;
    loadFacts();
    loadEpisodes(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per mount, deliberately.
  }, [memory]);

  useEffect(() => {
    if (subscribe === undefined) return;
    return subscribe((event) => {
      if (event.type === 'assistant.message') setInjectedTick((tick) => tick + 1);
    });
  }, [subscribe]);

  const saveFact = useCallback(
    (fact: SemanticFact) => {
      if (memory === null) return;
      const value = factRow(fact.id).value;
      setFactUi((current) => ({ ...current, [fact.id]: { ...(current[fact.id] ?? DEFAULT_FACT_UI), busy: true } }));
      memory
        .correctFact({ ...fact, object: value })
        .then(() => {
          setFactUi((current) => ({ ...current, [fact.id]: DEFAULT_FACT_UI }));
          loadFacts();
        })
        .catch((error: unknown) => {
          setFactsError(messageOf(error));
          setFactUi((current) => ({ ...current, [fact.id]: { ...(current[fact.id] ?? DEFAULT_FACT_UI), busy: false } }));
        });
    },
    [factRow, loadFacts, memory],
  );

  const deleteFact = useCallback(
    (id: string) => {
      if (memory === null) return;
      setFactUi((current) => ({ ...current, [id]: { ...(current[id] ?? DEFAULT_FACT_UI), busy: true } }));
      memory
        .deleteFact(id)
        .then(() => {
          setFacts((current) => current.filter((fact) => fact.id !== id));
          setFactUi((current) => {
            const { [id]: _removed, ...rest } = current;
            return rest;
          });
        })
        .catch((error: unknown) => {
          setFactsError(messageOf(error));
          setFactUi((current) => ({ ...current, [id]: { ...(current[id] ?? DEFAULT_FACT_UI), busy: false } }));
        });
    },
    [memory],
  );

  const deleteEpisode = useCallback(
    (id: string) => {
      if (memory === null) return;
      setEpisodeUi((current) => ({ ...current, [id]: { ...(current[id] ?? DEFAULT_EPISODE_UI), busy: true } }));
      memory
        .deleteEpisode(id)
        .then(() => {
          setEpisodes((current) => current.filter((episode) => episode.id !== id));
          setSearchResults((current) => current.filter((episode) => episode.id !== id));
          setEpisodeUi((current) => {
            const { [id]: _removed, ...rest } = current;
            return rest;
          });
        })
        .catch((error: unknown) => {
          setEpisodesError(messageOf(error));
          setEpisodeUi((current) => ({ ...current, [id]: { ...(current[id] ?? DEFAULT_EPISODE_UI), busy: false } }));
        });
    },
    [memory],
  );

  const runSearch = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const query = searchInput.trim();
      if (memory === null || query === '') return;
      setSearchBusy(true);
      setEpisodesError(null);
      memory.kernel
        .searchEpisodes(query)
        .then((results) => {
          setActiveSearch(query);
          setSearchResults(results);
        })
        .catch((error: unknown) => setEpisodesError(messageOf(error)))
        .finally(() => setSearchBusy(false));
    },
    [memory, searchInput],
  );

  const clearSearch = useCallback(() => {
    setActiveSearch(null);
    setSearchInput('');
    setSearchResults([]);
  }, []);

  if (memory === null) {
    return (
      <section className="panel memory-panel">
        <div className="panel-header">
          <span className="panel-title">Memory</span>
        </div>
        <p className="memory-off">
          Memory is off — nothing said here is kept. <a href="/settings">Settings → Memory</a> turns it on.
        </p>
      </section>
    );
  }

  const last = memory.lastInjected();
  void injectedTick; // read here only to re-run this render when it changes.
  const visibleFacts = activeSearch === null ? facts : facts.filter((fact) => factLine(fact).toLowerCase().includes(activeSearch.toLowerCase()));
  const visibleEpisodes = activeSearch === null ? groupBySession(episodes) : null;

  return (
    <section className="panel memory-panel">
      <div className="panel-header">
        <span className="panel-title">Memory</span>
      </div>
      <p className="memory-where">Kept in {where}.</p>

      <div className="memory-log">
        <section className="memory-section">
          <h3 className="memory-section-title">What she was told last</h3>
          {last === null || last.memory === null ? (
            <p className="memory-empty">Nothing yet.</p>
          ) : (
            <>
              <p className="field-hint">as of {formatWhen(last.at)}</p>
              {last.memory.facts.length > 0 && (
                <ul className="memory-fact-list">
                  {last.memory.facts.map((fact) => (
                    <li key={fact.id}>{factLine(fact)}</li>
                  ))}
                </ul>
              )}
              {last.memory.episodes.length > 0 && (
                <ul className="memory-fact-list">
                  {last.memory.episodes.map((episode) => (
                    <li key={episode.id}>
                      {formatWhen(episode.at)}, {episode.role === 'user' ? 'they said' : `${characterName} said`}: “{episode.text}”
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="memory-section">
          <h3 className="memory-section-title">What she knows</h3>
          {factsError !== null && <p className="memory-error">{factsError}</p>}
          {factsLoading && facts.length === 0 ? (
            <p className="memory-empty">Loading…</p>
          ) : visibleFacts.length === 0 ? (
            <p className="memory-empty">Nothing yet.</p>
          ) : (
            <ul className="memory-fact-rows">
              {visibleFacts.map((fact) => {
                const ui = factRow(fact.id);
                return (
                  <li className="memory-fact-row" key={fact.id}>
                    {ui.editing ? (
                      <div className="memory-fact-edit">
                        <span className="memory-fact-subject">
                          {fact.subject.replaceAll('_', ' ')} {fact.predicate.replaceAll('_', ' ')}
                        </span>
                        <input
                          aria-label={`Edit ${fact.subject} ${fact.predicate}`}
                          className="input"
                          onChange={(event) => setFactUi((current) => ({ ...current, [fact.id]: { ...ui, value: event.target.value } }))}
                          value={ui.value}
                        />
                        <button className="btn btn-sm btn-primary" disabled={ui.busy} onClick={() => saveFact(fact)} type="button">
                          {ui.busy ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={ui.busy}
                          onClick={() => setFactUi((current) => ({ ...current, [fact.id]: DEFAULT_FACT_UI }))}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : ui.confirming ? (
                      <div className="memory-confirm">
                        <span>Forget this for good?</span>
                        <button className="btn btn-sm btn-danger" disabled={ui.busy} onClick={() => deleteFact(fact.id)} type="button">
                          {ui.busy ? 'Forgetting…' : 'Confirm'}
                        </button>
                        <button className="btn btn-sm btn-ghost" disabled={ui.busy} onClick={() => setFactUi((current) => ({ ...current, [fact.id]: DEFAULT_FACT_UI }))} type="button">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="memory-fact-line">{factLine(fact)}</span>
                        <span className="memory-fact-actions">
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => setFactUi((current) => ({ ...current, [fact.id]: { ...DEFAULT_FACT_UI, editing: true, value: fact.object } }))}
                            type="button"
                          >
                            Edit
                          </button>
                          <button className="btn btn-sm btn-ghost" onClick={() => setFactUi((current) => ({ ...current, [fact.id]: { ...DEFAULT_FACT_UI, confirming: true } }))} type="button">
                            Delete
                          </button>
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="memory-section">
          <h3 className="memory-section-title">Conversations</h3>
          <form className="memory-search" onSubmit={runSearch}>
            <input
              aria-label="Search conversations"
              className="input"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search…"
              value={searchInput}
            />
            <button className="btn btn-sm" disabled={searchBusy || searchInput.trim() === ''} type="submit">
              {searchBusy ? 'Searching…' : 'Search'}
            </button>
            {activeSearch !== null && (
              <button className="btn btn-sm btn-ghost" onClick={clearSearch} type="button">
                Back to full list
              </button>
            )}
          </form>

          {episodesError !== null && <p className="memory-error">{episodesError}</p>}

          {activeSearch !== null ? (
            searchResults.length === 0 ? (
              <p className="memory-empty">Nothing found.</p>
            ) : (
              <div className="memory-episode-group">
                {searchResults.map((episode) => (
                  <EpisodeRow
                    characterName={characterName}
                    episode={episode}
                    key={episode.id}
                    onConfirmChange={(id, confirming) => setEpisodeUi((current) => ({ ...current, [id]: { ...episodeRow(id), confirming } }))}
                    onDelete={deleteEpisode}
                    ui={episodeRow(episode.id)}
                  />
                ))}
              </div>
            )
          ) : episodesLoading && episodes.length === 0 ? (
            <p className="memory-empty">Loading…</p>
          ) : (visibleEpisodes?.length ?? 0) === 0 ? (
            <p className="memory-empty">Nothing yet.</p>
          ) : (
            <>
              {visibleEpisodes?.map((group) => (
                <div className="memory-episode-group" key={group.sessionId}>
                  <h4 className="memory-episode-heading">{formatWhen(group.firstAt)}</h4>
                  {group.episodes.map((episode) => (
                    <EpisodeRow
                      characterName={characterName}
                      episode={episode}
                      key={episode.id}
                      onConfirmChange={(id, confirming) => setEpisodeUi((current) => ({ ...current, [id]: { ...episodeRow(id), confirming } }))}
                      onDelete={deleteEpisode}
                      ui={episodeRow(episode.id)}
                    />
                  ))}
                </div>
              ))}
              {hasMore && (
                <button className="btn btn-sm btn-ghost memory-load-more" disabled={olderBusy} onClick={() => loadEpisodes(episodes.at(-1)?.at ?? null)} type="button">
                  {olderBusy ? 'Loading…' : 'Older'}
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
