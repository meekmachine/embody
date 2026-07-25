import type { Profile } from './types';
import { initEmbodyCore } from '../wasm';
import type { EmbodyCoreWasmModule } from '../wasmTypes';

/**
 * Extend a base preset with a profile extension.
 *
 * Implemented by the Rust Wasm core.
 *
 * Rules:
 * - Scalars: extension wins when provided.
 * - Maps: shallow-merged by key, values cloned.
 * - Arrays: replaced when the extension provides them (except annotationRegions).
 * - annotationRegions: merged by region name, with nested camera/style fields preserved.
 */
export function mergePresetWithProfile(
  core: EmbodyCoreWasmModule,
  base: Profile,
  extension?: Partial<Profile>
): Profile {
  if (!extension) {
    return base;
  }

  return JSON.parse(
    core.merge_preset_profile(JSON.stringify(base), JSON.stringify(extension))
  ) as Profile;
}

/** Resolve a preset/profile pair through this package entry's Wasm loader. */
export async function extendPresetWithProfile(
  base: Profile,
  extension?: Partial<Profile>
): Promise<Profile> {
  return mergePresetWithProfile(await initEmbodyCore(), base, extension);
}
