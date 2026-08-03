import { initEmbodyCore } from './index';

// Embody's ESM runtime is mandatory. Importers do not need a separate startup
// phase before calling synchronous profile and authoring operations.
await initEmbodyCore();

export * from './index';
