/**
 * Regenerate the JSON presets embedded by the Rust/Wasm core from the
 * TypeScript authoring sources.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const presetModulePath = resolve(root, 'dist/preset.js');
const mod = await import(pathToFileURL(presetModulePath).href);

const presets = [
  ['cc4', 'CC4_PRESET'],
  ['fish', 'BETTA_FISH_PRESET'],
];

for (const [presetId, exportName] of presets) {
  const outPath = resolve(root, `rust/embody-wasm/assets/presets/${presetId}.json`);
  const json = JSON.stringify(mod[exportName]);

  if (check) {
    const embedded = readFileSync(outPath, 'utf8');
    if (embedded !== json) {
      throw new Error(
        `Embedded ${presetId} preset is stale. Run \`npm run preset:export\` and commit the result.`,
      );
    }
    console.log(`Verified ${outPath} (${json.length} bytes)`);
    continue;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);
  console.log(`Wrote ${outPath} (${json.length} bytes)`);
}
