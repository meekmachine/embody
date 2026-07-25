/**
 * Regenerate rust/embody-wasm/assets/presets/cc4.json from the TypeScript
 * CC4_PRESET source. Runtime loads the embedded copy inside Wasm; this script
 * is only for refreshing that asset when the TS authoring source changes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = resolve(root, 'rust/embody-wasm/assets/presets/cc4.json');
const mod = await import(pathToFileURL(resolve(root, 'src/presets/cc4.ts')).href);
const json = JSON.stringify(mod.CC4_PRESET);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, json);
console.log(`Wrote ${outPath} (${json.length} bytes)`);
