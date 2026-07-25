import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HAIR_COLOR_APPEARANCE,
  HAIR_COLOR_PRESETS,
  normalizeHairColorAppearance,
} from './appearance';

describe('hair appearance', () => {
  it('exposes named color presets', () => {
    expect(HAIR_COLOR_PRESETS.natural_brown.baseColor).toBe('#4a3728');
    expect(HAIR_COLOR_PRESETS.neon_pink.emissiveIntensity).toBeGreaterThan(0);
  });

  it('normalizes hex strings and preset keys', () => {
    expect(normalizeHairColorAppearance('#abcdef').baseColor).toBe('#abcdef');
    expect(normalizeHairColorAppearance('neon_blue').baseColor).toBe(
      HAIR_COLOR_PRESETS.neon_blue.baseColor,
    );
    expect(normalizeHairColorAppearance(null).baseColor).toBe(
      DEFAULT_HAIR_COLOR_APPEARANCE.baseColor,
    );
  });
});
