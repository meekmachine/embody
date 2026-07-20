import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARACTER_LIGHTING_SETTINGS,
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
