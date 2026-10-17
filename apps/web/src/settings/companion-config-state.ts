import { useCallback, useEffect, useRef, useState } from 'react';
import { companionToolServers, type CompanionToolServer, type CompanionToolsOptions, type HttpFetch } from '@latentpresence/providers/web';
import type { CompanionConfig, CompanionConfigApi, CompanionConfigChange } from '../desktop/companion-config';

/**
 * The state behind the companion's settings in the desktop app (P8-T06): one `CompanionConfig`,
 * replaced by whatever each change returns, and the sentence of a refusal kept next to the topic
 * that caused it. Settings shows every topic; the wizard's step shows three of them, and its
 * summary reads the same state, so the hook lives in whichever page owns them.
 *
 * - **One action at a time.** `busy` is true from the press until the companion has restarted;
 *   every button in the panels is disabled meanwhile.
 * - **Adding something turns its switch on, never off** (`switches.turnOn`): her tools from the
 *   companion (Settings → Tools) and her search of documents are both off by default and an
 *   added server would otherwise do nothing.
 * - **Home Assistant's state** after a change is read from the companion's tool list until it is
 *   no longer `starting`.
 */

export type CompanionTopic = 'home' | 'files' | 'documents' | 'embedding' | 'web' | 'databases' | 'programs';

/** The two switches an added thing needs, and how to turn one on. */
export interface CompanionSwitches {
  /** Settings → Tools → "Offer the companion's tools". */
  readonly tools: boolean;
  /** Settings → Documents → whether she may search them. */
  readonly search: boolean;
  readonly turnOn: (which: 'tools' | 'search') => void;
}

export interface HomeState {
  readonly pending: boolean;
  readonly tone: 'ok' | 'warn' | 'danger';
  readonly text: string;
}

export interface CompanionConfigOptions {
  /** The shell's commands; null in a browser, where nothing loads. */
  readonly api: CompanionConfigApi | null;
  readonly switches: CompanionSwitches;
  readonly companionUrl: string;
  readonly fetch: HttpFetch;
  /** Test seam: what the Home Assistant state asks. Omitted, the companion's real `/mcp/tools`. */
  readonly listCompanion?: ((options: CompanionToolsOptions) => Promise<CompanionToolServer[]>) | undefined;
  /** How long to wait for Home Assistant to leave `starting`. */
  readonly waitMs?: number | undefined;
  readonly pollMs?: number | undefined;
}

export interface CompanionController {
  readonly config: CompanionConfig | null;
  readonly loading: boolean;
  /** Why reading failed: its sentence. */
  readonly loadError: string | null;
  /** Something is in flight; the panels disable their buttons. */
  readonly busy: boolean;
  readonly errors: Partial<Record<CompanionTopic, string>>;
  readonly notices: Partial<Record<CompanionTopic, string>>;
  readonly homeState: HomeState | null;
  /** Changes whenever `topic` was replaced by a result, so a form can start over from it. */
  readonly version: (topic: CompanionTopic) => number;
  /** Reads once if nothing was read yet. */
  readonly load: () => void;
  /** Reads again, after a failed read. */
  readonly retry: () => void;
  readonly change: (topic: CompanionTopic, change: CompanionConfigChange) => Promise<boolean>;
  readonly pickFolder: (target: 'files' | 'documents') => Promise<boolean>;
  readonly pickSqlite: (name: string) => Promise<boolean>;
  readonly openFile: () => Promise<void>;
  readonly reload: () => Promise<boolean>;
  /** Asks the companion whether Home Assistant is up, once. */
  readonly checkHome: () => Promise<void>;
}

const HOME_SERVER_ID = 'homeassistant';

/** The sentence meant for the person: the shell rejects with a string, a test with an Error. */
export function sentenceOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function without(record: Partial<Record<CompanionTopic, string>>, topic: CompanionTopic): Partial<Record<CompanionTopic, string>> {
  const { [topic]: _dropped, ...rest } = record;
  return rest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a change adds, if anything: the switch it needs. */
function needs(change: CompanionConfigChange): 'tools' | null {
  switch (change.kind) {
    case 'home':
    case 'addDatabase':
      return 'tools';
    case 'web':
      return change.provider !== null || change.readPages ? 'tools' : null;
    default:
      return null;
  }
}

const TOOLS_NOTICE = 'Turned on "Offer the companion\'s tools" (Settings → Tools), so she can use it.';
const SEARCH_NOTICE = 'Turned on her search of documents (Settings → Documents), so she can use it.';

export function useCompanionConfig(options: CompanionConfigOptions): CompanionController {
  const { api, companionUrl, fetch, listCompanion, waitMs = 30_000, pollMs = 1000 } = options;
  const [config, setConfig] = useState<CompanionConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<CompanionTopic, string>>>({});
  const [notices, setNotices] = useState<Partial<Record<CompanionTopic, string>>>({});
  const [homeState, setHomeState] = useState<HomeState | null>(null);
  const [versions, setVersions] = useState<Partial<Record<CompanionTopic, number>>>({});

  const mounted = useRef(true);
  const busyRef = useRef(false);
  const asked = useRef(false);
  const switchesRef = useRef(options.switches);
  const homeRun = useRef(0);

  useEffect(() => {
    switchesRef.current = options.switches;
  }, [options.switches]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async (): Promise<void> => {
    if (api === null) return;
    setLoading(true);
    setLoadError(null);
    try {
      const next = await api.read();
      if (mounted.current) setConfig(next);
    } catch (error) {
      if (mounted.current) setLoadError(sentenceOf(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [api]);

  const load = useCallback((): void => {
    if (api === null || asked.current) return;
    asked.current = true;
    void read();
  }, [api, read]);

  const retry = useCallback((): void => {
    void read();
  }, [read]);

  /** Runs one action: one at a time; the result replaces the view, a refusal's sentence stays by its topic. */
  const run = useCallback(
    async (topic: CompanionTopic, action: () => Promise<CompanionConfig | null>, needed: 'tools' | 'search' | null): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setErrors((previous) => without(previous, topic));
      setNotices((previous) => without(previous, topic));
      try {
        const next = await action();
        if (!mounted.current || next === null) return false;
        setConfig(next);
        setVersions((previous) => ({ ...previous, [topic]: (previous[topic] ?? 0) + 1 }));
        const switches = switchesRef.current;
        if (needed === 'tools' && !switches.tools) {
          switches.turnOn('tools');
          setNotices((previous) => ({ ...previous, [topic]: TOOLS_NOTICE }));
        } else if (needed === 'search' && !switches.search) {
          switches.turnOn('search');
          setNotices((previous) => ({ ...previous, [topic]: SEARCH_NOTICE }));
        }
        return true;
      } catch (error) {
        if (mounted.current) setErrors((previous) => ({ ...previous, [topic]: sentenceOf(error) }));
        return false;
      } finally {
        busyRef.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );

  /** Waits for Home Assistant to leave `starting` (or `waitMs` to pass), then says what it found. */
  const watchHome = useCallback(
    async (wait: number): Promise<void> => {
      const ticket = ++homeRun.current;
      const list = listCompanion ?? companionToolServers;
      setHomeState({ pending: true, tone: 'warn', text: 'Checking Home Assistant…' });
      const deadline = Date.now() + wait;
      for (;;) {
        try {
          const servers = await list({ baseUrl: companionUrl, fetch });
          const home = servers.find((candidate) => candidate.server.id === HOME_SERVER_ID);
          if (home?.server.state === 'ready') {
            if (mounted.current && ticket === homeRun.current) setHomeState({ pending: false, tone: 'ok', text: 'Connected' });
            return;
          }
          if (home?.server.state === 'failed') {
            if (mounted.current && ticket === homeRun.current) {
              setHomeState({ pending: false, tone: 'danger', text: home.server.detail ?? 'Home Assistant did not start.' });
            }
            return;
          }
        } catch {
          // The companion is restarting; ask again until the time is up.
        }
        if (!mounted.current || ticket !== homeRun.current) return;
        if (Date.now() >= deadline) break;
        await sleep(pollMs);
      }
      if (mounted.current && ticket === homeRun.current) {
        setHomeState({ pending: false, tone: 'warn', text: 'Home Assistant is still starting. Press Check in a moment.' });
      }
    },
    [companionUrl, fetch, listCompanion, pollMs],
  );

  const change = useCallback(
    async (topic: CompanionTopic, requested: CompanionConfigChange): Promise<boolean> => {
      if (api === null) return false;
      const done = await run(topic, () => api.change(requested), needs(requested));
      if (done && requested.kind === 'home') void watchHome(waitMs);
      if (done && requested.kind === 'removeHome') {
        homeRun.current += 1;
        setHomeState(null);
      }
      return done;
    },
    [api, run, watchHome, waitMs],
  );

  const pickFolder = useCallback(
    (target: 'files' | 'documents'): Promise<boolean> => {
      if (api === null) return Promise.resolve(false);
      return run(target, () => api.pickFolder(target), target === 'files' ? 'tools' : 'search');
    },
    [api, run],
  );

  const pickSqlite = useCallback(
    (name: string): Promise<boolean> => {
      if (api === null) return Promise.resolve(false);
      return run('databases', () => api.pickSqlite(name), 'tools');
    },
    [api, run],
  );

  const openFile = useCallback(async (): Promise<void> => {
    if (api === null) return;
    setErrors((previous) => without(previous, 'programs'));
    try {
      await api.openFile();
    } catch (error) {
      if (mounted.current) setErrors((previous) => ({ ...previous, programs: sentenceOf(error) }));
    }
  }, [api]);

  const reload = useCallback((): Promise<boolean> => {
    if (api === null) return Promise.resolve(false);
    return run('programs', () => api.reload(), null);
  }, [api, run]);

  const checkHome = useCallback((): Promise<void> => watchHome(0), [watchHome]);

  const version = useCallback((topic: CompanionTopic): number => versions[topic] ?? 0, [versions]);

  return { config, loading, loadError, busy, errors, notices, homeState, version, load, retry, change, pickFolder, pickSqlite, openFile, reload, checkHome };
}
