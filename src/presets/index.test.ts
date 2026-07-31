import { describe, expect, it } from 'vitest';
import {
  BETTA_FISH_PRESET,
  CC4_PRESET,
  EMBEDDED_PRESETS,
  FISH_AU_MAPPING_CONFIG,
  getEmbeddedPreset,
  getPreset,
} from './index';

describe('getPreset', () => {
  it('exposes canonical preset IDs through one authored registry', () => {
    expect(Object.keys(EMBEDDED_PRESETS)).toEqual(expect.arrayContaining(['cc4', 'fish']));
    expect(getEmbeddedPreset('CC4')).toBe(CC4_PRESET);
    expect(getEmbeddedPreset('fish')).toBe(BETTA_FISH_PRESET);
    expect(getEmbeddedPreset('skeletal')).toBeUndefined();
  });

  it('keeps skeletal as a TypeScript compatibility alias only', () => {
    expect(getPreset('fish')).toBe(BETTA_FISH_PRESET);
    expect(getPreset('skeletal')).toBe(BETTA_FISH_PRESET);
  });

  it('keeps the legacy fish mapping alias pointed at the real fish preset', () => {
    expect(FISH_AU_MAPPING_CONFIG).toBe(BETTA_FISH_PRESET);
  });

  it('keeps Betta mesh/material defaults in the preset instead of Firestore-only overrides', () => {
    expect(BETTA_FISH_PRESET.meshes?.BODY_0?.material).toMatchObject({
      renderOrder: 20,
      transparent: true,
      opacity: 1,
    });
    expect(BETTA_FISH_PRESET.meshes?.EYES_0?.material).toMatchObject({
      renderOrder: 17,
      transparent: true,
      opacity: 1,
    });
    expect(BETTA_FISH_PRESET.meshes?.Cube_0?.material).toMatchObject({
      renderOrder: -20,
      transparent: true,
      opacity: 0,
    });
  });
});
