export {
  DEFAULT_FORGETTING,
  consolidateFacts,
  type ConsolidationPlan,
  type ForgettingPolicy,
} from './consolidate';
export { EXTRACTION_SYSTEM, extractionMessages, parseExtraction, type Exchange, type ParsedExtraction } from './extract';
export {
  SINGLE_VALUED_PREDICATES,
  canonicalTerm,
  planFactWrites,
  reinforce,
  type ExtractedFact,
  type FactWrites,
  type PlanFactsOptions,
} from './facts';
export { FakeMemoryStore } from './fake-store';
export {
  MemoryKernel,
  type ExtractionRecord,
  type MemoryErrorStage,
  type MemoryKernelOptions,
  type MemoryTurn,
} from './kernel';
export {
  DEFAULT_RECALL_PARAMS,
  factLine,
  rankRecall,
  renderMemory,
  salience,
  type MemoryContext,
  type RecallParams,
} from './recall';
