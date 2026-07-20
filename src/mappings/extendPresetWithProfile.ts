import type { Profile } from './types';
import { getEmbodyCoreSync } from '../wasm';

/**
 * Extend a base preset with a profile extension.
 *
 * Implemented in the Rust Wasm core (`merge_preset_profile`). Requires
 * `await initEmbodyCore()` first.
 *
 * Rules:
 * - Scalars: extension wins when provided.
 * - Maps: shallow-merged by key, values cloned.
 * - Arrays: replaced when the extension provides them (except annotationRegions).
 * - annotationRegions: merged by region name, with nested camera/style fields preserved.
 */
export function extendPresetWithProfile(base: Profile, extension?: Partial<Profile>): Profile {
  if (!extension) {
    return base;
  }

  const wasm = getEmbodyCoreSync();
  const mergedJson = wasm.merge_preset_profile(
    JSON.stringify(base),
    JSON.stringify(extension)
  );
  return JSON.parse(mergedJson) as Profile;
}
