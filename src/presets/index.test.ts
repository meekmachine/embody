import { describe, expect, it } from 'vitest';
import { BETTA_FISH_PRESET, FISH_AU_MAPPING_CONFIG, getPreset } from './index';

describe('getPreset', () => {
  it('returns the Betta fish preset content for fish aliases via Rust', () => {
    expect(getPreset('fish')).toMatchObject({
      name: BETTA_FISH_PRESET.name,
      animalType: BETTA_FISH_PRESET.animalType,
    });
    expect(getPreset('skeletal')).toMatchObject({
      name: BETTA_FISH_PRESET.name,
      animalType: BETTA_FISH_PRESET.animalType,
    });
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
