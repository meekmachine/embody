import type { Profile } from '../mappings/types';
import { BETTA_FISH_PRESET } from './bettaFish';
import { CC4_PRESET } from './cc4';

/**
 * Authoring registry for presets embedded in the Rust/Wasm package.
 *
 * Preset IDs are data identifiers. Runtime code must look them up through the
 * generated Wasm registry rather than branching on individual characters.
 */
export const EMBEDDED_PRESETS = {
  cc4: CC4_PRESET,
  fish: BETTA_FISH_PRESET,
} as const satisfies Record<string, Profile>;

export type EmbeddedPresetId = keyof typeof EMBEDDED_PRESETS;

export function getEmbeddedPreset(presetId: string): Profile | undefined {
  const normalized = presetId.trim().toLowerCase();
  return (EMBEDDED_PRESETS as Record<string, Profile>)[normalized];
}
