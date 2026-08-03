import { initEmbodyCore } from './index';

// Start the mandatory runtime as soon as the ESM entry is evaluated. Consumers
// that need synchronous APIs await initEmbodyCore(), which reuses this promise.
void initEmbodyCore();

export * from './index';
