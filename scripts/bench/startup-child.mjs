import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// A fresh process is necessary: initEmbodyCore caches its initialization promise
// and native ESM imports also cache module evaluation within a process.
const started = performance.now();
const { initEmbodyCore } = await import('@lovelace_lol/embody/wasm');
const wasm = await initEmbodyCore();
const importAndInitializeMs = performance.now() - started;
const core = new wasm.RuntimeCore(0);
try {
  assert.equal(core.get_au(200), 0);
} finally {
  core.free();
}
console.log(JSON.stringify({ importAndInitializeMs }));
