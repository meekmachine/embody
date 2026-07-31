/**
 * Regenerate the JSON presets embedded by the Rust/Wasm core from the
 * TypeScript authoring sources.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const presetModulePath = resolve(root, 'dist/preset.js');
const mod = await import(pathToFileURL(presetModulePath).href);
const presets = mod.EMBEDDED_PRESETS;
const presetDirectory = resolve(root, 'rust/embody-wasm/assets/presets');

if (!presets || typeof presets !== 'object' || Array.isArray(presets)) {
  throw new Error('Preset authoring entry must export an EMBEDDED_PRESETS object.');
}

const presetEntries = Object.entries(presets).sort(([left], [right]) =>
  left.localeCompare(right),
);

for (const [presetId, preset] of presetEntries) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(presetId)) {
    throw new Error(
      `Invalid embedded preset id "${presetId}". Use lowercase letters, digits, "_" or "-".`,
    );
  }

  const outPath = resolve(presetDirectory, `${presetId}.json`);
  const json = JSON.stringify(preset);

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

if (check) {
  const expectedFiles = new Set(presetEntries.map(([presetId]) => `${presetId}.json`));
  const unexpectedFiles = readdirSync(presetDirectory)
    .filter((fileName) => fileName.endsWith('.json') && !expectedFiles.has(fileName));

  if (unexpectedFiles.length > 0) {
    throw new Error(
      `Embedded preset assets are not registered: ${unexpectedFiles.join(', ')}`,
    );
  }
}
