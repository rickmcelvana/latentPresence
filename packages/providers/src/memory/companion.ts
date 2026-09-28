import {
  CompanionErrorSchema,
  companionRoutes,
  type CompanionRouteName,
  type MemoryCapabilities,
  type MemoryEpisode,
  type MemoryStore,
  type PlanDocument,
  type RetrievalBundle,
  type RetrievalRequest,
  type Schedule,
  type SelfModelBlock,
  type SemanticFact,
} from '@latentpresence/protocol';
import { MemoryStoreError } from '@latentpresence/core';
import type { z } from 'zod';
import type { HttpFetch } from '../llm/discovery';
import { normaliseBaseUrl } from '../llm/discovery';

/**
 * `MemoryStore` over the companion's HTTP surface (P4-T04, ADR-17): the optional local
 * Rust service and MariaDB behind it. Every route, method and shape comes from
 * `companionRoutes` — nothing here repeats a path or a method literally — because a page
 * can talk to an older companion build (`companion.ts`'s own header), and the only way to
 * notice is to parse every response against the contract rather than trust the status code.
 *
 * `remote: true` (ADR-17): every method here is a round trip, which is why the kernel's
 * `retrieve` is one call for everything a turn needs rather than four.
 */
export interface CompanionMemoryStoreConfig {
  /** The companion's origin, e.g. `http://127.0.0.1:8787` — settings' `companionUrl`. */
  readonly baseUrl: string;
  /** Injected transport for tests; defaults to the global `fetch`. */
  readonly fetch?: HttpFetch;
}

interface CallOptions {
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export class CompanionMemoryStore implements MemoryStore {
  readonly id = 'mariadb';
  private readonly baseUrl: string;
  private readonly fetchImpl: HttpFetch;

  constructor(config: CompanionMemoryStoreConfig) {
    this.baseUrl = normaliseBaseUrl(config.baseUrl);
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async capabilities(): Promise<MemoryCapabilities> {
    // No round trip: what a companion supports is fixed by this adapter, not discovered.
    return { vectorSearch: true, dimensions: null, bitemporalFacts: true, plans: true, schedules: false, remote: true };
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalBundle> {
    return this.call('dbRetrieve', { body: request });
  }

  async appendEpisode(episode: MemoryEpisode): Promise<void> {
    await this.call('dbAppendEpisode', { body: episode });
  }

  async upsertFact(fact: SemanticFact): Promise<void> {
    await this.call('dbUpsertFact', { body: fact });
  }

  async supersedeFact(id: string, validTo: string): Promise<void> {
    await this.call('dbSupersedeFact', { body: { id, validTo } });
  }

  async expireFact(id: string, at: string): Promise<void> {
    await this.call('dbExpireFact', { body: { id, at } });
  }

  async currentFacts(characterId: string): Promise<SemanticFact[]> {
    const { facts } = await this.call('dbCurrentFacts', { query: { characterId } });
    return facts;
  }

  async readBlocks(characterId: string): Promise<SelfModelBlock[]> {
    const { blocks } = await this.call('dbReadBlocks', { query: { characterId } });
    return blocks;
  }

  async writeBlock(block: SelfModelBlock): Promise<void> {
    await this.call('dbWriteBlock', { body: block });
  }

  async savePlan(plan: PlanDocument): Promise<void> {
    await this.call('dbSavePlan', { body: plan });
  }

  async listPlans(characterId: string): Promise<PlanDocument[]> {
    const { plans } = await this.call('dbListPlans', { query: { characterId } });
    return plans;
  }

  // The companion has no schedule routes yet (brief, P4-T04): refuse without a request
  // rather than call a route that does not exist.
  async listSchedules(_characterId: string): Promise<Schedule[]> {
    throw CompanionMemoryStore.noSchedules();
  }

  async saveSchedule(_schedule: Schedule): Promise<void> {
    throw CompanionMemoryStore.noSchedules();
  }

  async deleteSchedule(_id: string): Promise<void> {
    throw CompanionMemoryStore.noSchedules();
  }

  private static noSchedules(): MemoryStoreError {
    return new MemoryStoreError('unavailable', 'this companion does not keep schedules yet');
  }

  /**
   * Every request the adapter makes. Method, path and both schemas come from
   * `companionRoutes[routeName]`, so a new route only ever needs a new call site here, not
   * a new place to get the path or the method wrong.
   */
  private async call<Name extends CompanionRouteName>(routeName: Name, options: CallOptions): Promise<z.infer<(typeof companionRoutes)[Name]['response']>> {
    const route = companionRoutes[routeName];
    const url = new URL(`${this.baseUrl}${route.path}`);
    if (options.query) for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);

    const init: RequestInit = options.body === undefined ? { method: route.method } : { method: route.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) };

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new MemoryStoreError('unavailable', `could not reach the companion at ${this.baseUrl} — is it running? (${String(error)})`);
    }

    const json: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const parsedError = CompanionErrorSchema.safeParse(json);
      if (parsedError.success) throw new MemoryStoreError(parsedError.data.error.code, parsedError.data.error.message);
      throw new MemoryStoreError('internal', `companion returned ${response.status} for ${routeName}`);
    }

    const parsed = route.response.safeParse(json);
    if (!parsed.success) {
      throw new MemoryStoreError('internal', `the companion's response to ${routeName} did not match the expected shape — it may be a different version`);
    }
    return parsed.data as z.infer<(typeof companionRoutes)[Name]['response']>;
  }
}
