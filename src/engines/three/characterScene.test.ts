import { describe, expect, it } from 'vitest';
import {
  CHARACTER_SCENE_TYPE_IDS,
  CHARACTER_SCENE_TYPES,
  DEFAULT_CHARACTER_LIGHTING_PRESETS,
  DEFAULT_CHARACTER_LIGHTING_SETTINGS,
  DEFAULT_CHARACTER_SCENE_TYPE_ID,
  normalizeDefaultCharacterLightingSettings,
} from './characterScene';

describe('normalizeDefaultCharacterLightingSettings', () => {
  it('normalizes persisted lighting values from stored character profiles', () => {
    expect(normalizeDefaultCharacterLightingSettings({
      envMapEnabled: false,
      environmentIntensity: '0.42',
      environmentBlur: 2,
      exposure: 'not-a-number',
      ambientIntensity: -1,
      keyIntensity: 4,
      fillIntensity: 0.33,
      rimIntensity: undefined,
      shadowOpacity: 0.9,
    })).toEqual({
      envMapEnabled: false,
      environmentIntensity: 0.42,
      environmentBlur: 0.04,
      exposure: DEFAULT_CHARACTER_LIGHTING_SETTINGS.exposure,
      ambientIntensity: 0,
      keyIntensity: 2.2,
      fillIntensity: 0.33,
      rimIntensity: DEFAULT_CHARACTER_LIGHTING_SETTINGS.rimIntensity,
      shadowOpacity: 0.5,
    });
  });

  it('ignores non-object profile values', () => {
    expect(normalizeDefaultCharacterLightingSettings(null)).toBeNull();
    expect(normalizeDefaultCharacterLightingSettings('soft')).toBeNull();
    expect(normalizeDefaultCharacterLightingSettings([])).toBeNull();
  });
});

describe('character scene types', () => {
  it('registers every scene type id with a consistent definition', () => {
    expect(Object.keys(CHARACTER_SCENE_TYPES).sort()).toEqual([...CHARACTER_SCENE_TYPE_IDS].sort());
    CHARACTER_SCENE_TYPE_IDS.forEach((id) => {
      const definition = CHARACTER_SCENE_TYPES[id];
      expect(definition.id).toBe(id);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(DEFAULT_CHARACTER_LIGHTING_PRESETS[definition.lightingPreset]).toBeDefined();
    });
  });

  it('uses studio as the default scene type', () => {
    expect(DEFAULT_CHARACTER_SCENE_TYPE_ID).toBe('studio');
    expect(CHARACTER_SCENE_TYPES.studio.background).toBeNull();
    expect(CHARACTER_SCENE_TYPES.void.shadowPlane).toBe(false);
  });
});
