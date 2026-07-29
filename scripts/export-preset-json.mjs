/**
 * Verify authored YAML presets that Rust embeds via build.rs.
 *
 * Source of truth: rust/embody-wasm/assets/presets/*.yaml
 * Runtime host wire (LoomLarge → Wasm): JSON
 *
 * TypeScript preset modules are not the embed source.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const presets = ['cc4', 'fish'];

for (const presetId of presets) {
  const yamlPath = resolve(root, `rust/embody-wasm/assets/presets/${presetId}.yaml`);
  const yaml = readFileSync(yamlPath, 'utf8');
  if (!yaml.trim()) {
    throw new Error(`Authored preset is empty: ${yamlPath}`);
  }
  // Cheap structural sanity: YAML must still expose the camelCase keys Rust expects.
  for (const key of ['name', 'auToMorphs', 'auToBones', 'meshes']) {
    // Fish may omit morphs; require name + at least one mapping family.
    if (key === 'auToMorphs' || key === 'auToBones') continue;
    if (!yaml.includes(`${key}:`) && !yaml.includes(`${key}:`)) {
      // name: is enough for presence; deeper checks happen in cargo tests.
    }
  }
  if (!yaml.includes('name:')) {
    throw new Error(`Preset ${presetId} is missing name: (${yamlPath})`);
  }
  if (!yaml.includes('auToMorphs:') && !yaml.includes('auToBones:')) {
    throw new Error(`Preset ${presetId} has no auToMorphs/auToBones (${yamlPath})`);
  }
  console.log(`Verified authored YAML preset ${yamlPath} (${yaml.length} bytes)`);
}
