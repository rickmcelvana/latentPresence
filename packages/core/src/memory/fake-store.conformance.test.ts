import { describeMemoryStoreConformance } from './conformance';
import { FakeMemoryStore } from './fake-store';

// The fake keeps the stores' rules (P4-T03); this is what says so.
describeMemoryStoreConformance({ name: 'FakeMemoryStore', create: () => new FakeMemoryStore(), vectors: true });
