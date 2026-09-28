import { MemoryStoreError } from '@latentpresence/core';
import type {
  MemoryCapabilities,
  MemoryEpisode,
  MemoryStore,
  PlanDocument,
  RetrievalBundle,
  RetrievalRequest,
  Schedule,
  SelfModelBlock,
  SemanticFact,
} from '@latentpresence/protocol';

/**
 * The desktop `MemoryStore`, sqlite-vec over a local file — not yet. It ships with the
 * desktop app (a later phase); until then this is a placeholder that names itself and
 * refuses everything else, so the settings UI can list `sqlite` as a provider kind
 * without anything downstream having to special-case "not built yet".
 */
export class SqliteMemoryStore implements MemoryStore {
  readonly id = 'sqlite';

  async capabilities(): Promise<MemoryCapabilities> {
    return { vectorSearch: false, dimensions: null, bitemporalFacts: false, plans: false, schedules: false, remote: false };
  }

  async retrieve(_request: RetrievalRequest): Promise<RetrievalBundle> {
    throw SqliteMemoryStore.unavailable();
  }

  async appendEpisode(_episode: MemoryEpisode): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  async upsertFact(_fact: SemanticFact): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  async supersedeFact(_id: string, _validTo: string): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  async expireFact(_id: string, _at: string): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  async currentFacts(_characterId: string): Promise<SemanticFact[]> {
    throw SqliteMemoryStore.unavailable();
  }

  async deleteFact(_id: string): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  async listEpisodes(_characterId: string, _before: string | null): Promise<MemoryEpisode[]> {
    throw SqliteMemoryStore.unavailable();
  }

  async deleteEpisode(_id: string): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  async readBlocks(_characterId: string): Promise<SelfModelBlock[]> {
    throw SqliteMemoryStore.unavailable();
  }

  async writeBlock(_block: SelfModelBlock): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  async savePlan(_plan: PlanDocument): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  async listPlans(_characterId: string): Promise<PlanDocument[]> {
    throw SqliteMemoryStore.unavailable();
  }

  async listSchedules(_characterId: string): Promise<Schedule[]> {
    throw SqliteMemoryStore.unavailable();
  }

  async saveSchedule(_schedule: Schedule): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  async deleteSchedule(_id: string): Promise<void> {
    throw SqliteMemoryStore.unavailable();
  }

  private static unavailable(): MemoryStoreError {
    return new MemoryStoreError('unavailable', 'the SQLite store arrives with the desktop app');
  }
}
