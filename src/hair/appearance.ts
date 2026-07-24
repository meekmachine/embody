/**
 * Hair / eyebrow material appearance helpers.
 *
 * These are runtime material controls owned by Embody — not Polymer agencies.
 * Agencies govern character behavior; hair materials and physics stay here.
 */

export interface HairColorAppearance {
  name?: string;
  baseColor: string;
  emissive: string;
  emissiveIntensity: number;
}

export interface HairAppearanceState {
  hairColor: Required<Pick<HairColorAppearance, 'baseColor' | 'emissive' | 'emissiveIntensity'>> & {
    name?: string;
  };
  eyebrowColor: Required<Pick<HairColorAppearance, 'baseColor' | 'emissive' | 'emissiveIntensity'>> & {
    name?: string;
  };
  showOutline: boolean;
  outlineColor: string;
  outlineOpacity: number;
}

export const HAIR_COLOR_PRESETS: Record<string, Required<HairColorAppearance>> = {
  natural_black: {
    name: 'Natural Black',
    baseColor: '#1a1a1a',
    emissive: '#000000',
    emissiveIntensity: 0,
  },
  natural_brown: {
    name: 'Natural Brown',
    baseColor: '#4a3728',
    emissive: '#000000',
    emissiveIntensity: 0,
  },
  natural_blonde: {
    name: 'Natural Blonde',
    baseColor: '#e6c78a',
    emissive: '#000000',
    emissiveIntensity: 0,
  },
  natural_red: {
    name: 'Natural Red',
    baseColor: '#8b3a3a',
    emissive: '#000000',
    emissiveIntensity: 0,
  },
  natural_gray: {
    name: 'Natural Gray',
    baseColor: '#9e9e9e',
    emissive: '#000000',
    emissiveIntensity: 0,
  },
  natural_white: {
    name: 'Natural White',
    baseColor: '#f5f5f5',
    emissive: '#000000',
    emissiveIntensity: 0,
  },
  neon_blue: {
    name: 'Neon Blue',
    baseColor: '#00ffff',
    emissive: '#0000ff',
    emissiveIntensity: 0.8,
  },
  neon_pink: {
    name: 'Neon Pink',
    baseColor: '#ff00ff',
    emissive: '#ff1493',
    emissiveIntensity: 0.8,
  },
  neon_green: {
    name: 'Neon Green',
    baseColor: '#00ff00',
    emissive: '#00ff00',
    emissiveIntensity: 0.8,
  },
  electric_purple: {
    name: 'Electric Purple',
    baseColor: '#9d00ff',
    emissive: '#9d00ff',
    emissiveIntensity: 0.6,
  },
  fire_orange: {
    name: 'Fire Orange',
    baseColor: '#ff6600',
    emissive: '#ff3300',
    emissiveIntensity: 0.7,
  },
};

export const DEFAULT_HAIR_COLOR_APPEARANCE: Required<HairColorAppearance> =
  HAIR_COLOR_PRESETS.natural_brown;

export function normalizeHairColorAppearance(
  value: HairColorAppearance | string | null | undefined,
  fallback: Required<HairColorAppearance> = DEFAULT_HAIR_COLOR_APPEARANCE,
): Required<HairColorAppearance> {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('#')) {
      return {
        name: fallback.name,
        baseColor: trimmed,
        emissive: fallback.emissive,
        emissiveIntensity: fallback.emissiveIntensity,
      };
    }
    const preset = HAIR_COLOR_PRESETS[trimmed];
    if (preset) return { ...preset };
  }

  if (value && typeof value === 'object') {
    return {
      name: typeof value.name === 'string' ? value.name : fallback.name,
      baseColor: typeof value.baseColor === 'string' ? value.baseColor : fallback.baseColor,
      emissive: typeof value.emissive === 'string' ? value.emissive : fallback.emissive,
      emissiveIntensity:
        typeof value.emissiveIntensity === 'number'
          ? value.emissiveIntensity
          : fallback.emissiveIntensity,
    };
  }

  return { ...fallback };
}

export function colorToCssHex(color: { getHexString(): string } | undefined | null): string | null {
  if (!color || typeof color.getHexString !== 'function') return null;
  return `#${color.getHexString()}`;
}
