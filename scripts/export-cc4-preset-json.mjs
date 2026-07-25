/**
 * Regenerate rust/embody-wasm/assets/presets/cc4.json from the TypeScript
 * CC4_PRESET source. Runtime loads the embedded copy inside Wasm; this script
 * is only for refreshing that asset when the TS authoring source changes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = resolve(root, 'rust/embody-wasm/assets/presets/cc4.json');
const check = process.argv.includes('--check');
const presetModulePath = check
  ? resolve(root, 'dist/preset.js')
  : resolve(root, 'src/presets/cc4.ts');
const mod = await import(pathToFileURL(presetModulePath).href);
const json = JSON.stringify(mod.CC4_PRESET);

if (check) {
  const embedded = readFileSync(outPath, 'utf8');
  if (embedded !== json) {
    throw new Error(
      'Embedded CC4 preset is stale. Run `node scripts/export-cc4-preset-json.mjs` and commit the result.',
    );
  }
  console.log(`Verified ${outPath} (${json.length} bytes)`);
  process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, json);
console.log(`Wrote ${outPath} (${json.length} bytes)`);
