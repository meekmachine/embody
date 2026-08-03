import { initEmbodyCore } from './index';

// Embody's ESM runtime is mandatory. Module evaluation does not complete until
// synchronous profile, authoring, and runtime operations can call into Wasm.
await initEmbodyCore();

export * from './index';
