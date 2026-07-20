import { beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { EmbodyCoreWasmModule } from '../wasmTypes';
import { setEmbodyCoreForTests } from '../wasm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

beforeAll(async () => {
  const wasmJs = path.join(repoRoot, 'dist/wasm/embody_wasm.js');
  const wasmBin = path.join(repoRoot, 'dist/wasm/embody_wasm_bg.wasm');
  const mod = await import(pathToFileURL(wasmJs).href) as EmbodyCoreWasmModule;
  if (typeof mod.default === 'function') {
    await mod.default({ module_or_path: await readFile(wasmBin) });
  }
  setEmbodyCoreForTests(mod);
});
