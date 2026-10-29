import * as THREE from 'three';
import type { SceneInkBackgroundPalette } from './sceneInkBackground';

type PaletteMaterial = THREE.Material & {
  color?: THREE.Color;
  emissive?: THREE.Color;
  map?: THREE.Texture | null;
  emissiveMap?: THREE.Texture | null;
};

type WeightedColor = {
  color: THREE.Color;
  score: number;
};

type CachedPalette = {
  materialPalette?: SceneInkBackgroundPalette | null;
  texturePalette?: SceneInkBackgroundPalette | null;
  texturePalettePromise?: Promise<SceneInkBackgroundPalette | null>;
};

const paletteCache = new Map<string, CachedPalette>();
const MAX_TEXTURE_SAMPLE_SIZE = 10;
const MIN_SAMPLE_SATURATION = 0.04;
const MIN_CANDIDATE_DISTANCE = 0.12;

/** Reuse the finished palette on character switches without resampling textures. */
export function readCachedCharacterPalette(cacheKey: string): SceneInkBackgroundPalette | null {
  const cached = paletteCache.get(cacheKey);
  return cached?.texturePalette ?? cached?.materialPalette ?? null;
}

export function resolveCharacterMaterialPalette(
  model: THREE.Object3D,
  cacheKey: string,
): SceneInkBackgroundPalette | null {
  const cached = getCachedPalette(cacheKey);
  if (cached.materialPalette !== undefined) {
    return cached.materialPalette;
  }

  const samples = collectPaletteSamples(model, false);
  const palette = buildPalette(samples);
  cached.materialPalette = palette;
  return palette;
}

export function resolveCharacterTexturePalette(
  model: THREE.Object3D,
  cacheKey: string,
): Promise<SceneInkBackgroundPalette | null> {
  const cached = getCachedPalette(cacheKey);
  if (cached.texturePalette !== undefined) {
    return Promise.resolve(cached.texturePalette);
  }
  if (cached.texturePalettePromise) {
    return cached.texturePalettePromise;
  }

  cached.texturePalettePromise = schedulePaletteExtraction(() => {
    const samples = collectPaletteSamples(model, true);
    const palette = buildPalette(samples);
    cached.texturePalette = palette;
    return palette;
  });

  return cached.texturePalettePromise;
}

function getCachedPalette(cacheKey: string): CachedPalette {
  const cached = paletteCache.get(cacheKey) ?? {};
  paletteCache.set(cacheKey, cached);
  return cached;
}

function schedulePaletteExtraction(
  extractPalette: () => SceneInkBackgroundPalette | null,
): Promise<SceneInkBackgroundPalette | null> {
  return new Promise((resolve) => {
    const run = () => resolve(extractPalette());

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 700 });
      return;
    }

    globalThis.setTimeout(run, 0);
  });
}

function collectPaletteSamples(model: THREE.Object3D, includeTextures: boolean): WeightedColor[] {
  const samples: WeightedColor[] = [];
  const seenMaterials = new Set<string>();
  const seenTextures = new Set<string>();

  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) {
      return;
    }

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material || seenMaterials.has(material.uuid)) {
        continue;
      }
      seenMaterials.add(material.uuid);
      collectMaterialSamples(material as PaletteMaterial, samples, seenTextures, includeTextures);
    }
  });

  return samples;
}

function collectMaterialSamples(
  material: PaletteMaterial,
  samples: WeightedColor[],
  seenTextures: Set<string>,
  includeTextures: boolean,
): void {
  pushColorSample(samples, material.color, 1.25);
  pushColorSample(samples, material.emissive, 0.8);

  if (!includeTextures) {
    return;
  }

  if (material.map && !seenTextures.has(material.map.uuid)) {
    seenTextures.add(material.map.uuid);
    samples.push(...sampleTexture(material.map));
  }

  if (material.emissiveMap && !seenTextures.has(material.emissiveMap.uuid)) {
    seenTextures.add(material.emissiveMap.uuid);
    samples.push(...sampleTexture(material.emissiveMap).map(({ color, score }) => ({
      color,
      score: score * 0.65,
    })));
  }
}

function pushColorSample(samples: WeightedColor[], color: THREE.Color | undefined, score: number): void {
  if (!color || !isUsableColor(color)) {
    return;
  }

  samples.push({
    color: color.clone(),
    score,
  });
}

function sampleTexture(texture: THREE.Texture): WeightedColor[] {
  if (typeof document === 'undefined') {
    return [];
  }

  const image = texture.image as CanvasImageSource | undefined;
  const imageSize = getImageSize(image);
  if (!image || !imageSize) {
    return [];
  }

  const canvas = document.createElement('canvas');
  const width = Math.min(MAX_TEXTURE_SAMPLE_SIZE, imageSize.width);
  const height = Math.min(MAX_TEXTURE_SAMPLE_SIZE, imageSize.height);
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return [];
  }

  try {
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;
    const samples: WeightedColor[] = [];

    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] / 255;
      if (alpha < 0.18) {
        continue;
      }

      const color = new THREE.Color(
        data[index] / 255,
        data[index + 1] / 255,
        data[index + 2] / 255,
      );
      if (!isUsableColor(color)) {
        continue;
      }

      const hsl = { h: 0, s: 0, l: 0 };
      color.getHSL(hsl);
      samples.push({
        color,
        score: alpha * (0.4 + hsl.s * 1.3),
      });
    }

    return samples;
  } catch {
    return [];
  }
}

function getImageSize(image: CanvasImageSource | undefined): { width: number; height: number } | null {
  if (!image || !('width' in image) || !('height' in image)) {
    return null;
  }

  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
}

function isUsableColor(color: THREE.Color): boolean {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  return hsl.l > 0.05 && hsl.l < 0.94 && hsl.s >= MIN_SAMPLE_SATURATION;
}

function buildPalette(samples: WeightedColor[]): SceneInkBackgroundPalette | null {
  if (samples.length === 0) {
    return null;
  }

  const buckets = new Map<number, { color: THREE.Color; score: number }>();
  for (const sample of samples) {
    const hsl = { h: 0, s: 0, l: 0 };
    sample.color.getHSL(hsl);
    const bucketId = Math.floor(hsl.h * 18);
    const bucket = buckets.get(bucketId) ?? { color: new THREE.Color(0, 0, 0), score: 0 };
    bucket.color.r += sample.color.r * sample.score;
    bucket.color.g += sample.color.g * sample.score;
    bucket.color.b += sample.color.b * sample.score;
    bucket.score += sample.score;
    buckets.set(bucketId, bucket);
  }

  const candidates = Array.from(buckets.values())
    .filter((bucket) => bucket.score > 0)
    .map((bucket) => ({
      color: massageBackgroundTone(bucket.color.multiplyScalar(1 / bucket.score)),
      score: bucket.score,
    }))
    .sort((a, b) => b.score - a.score);

  const selected: THREE.Color[] = [];
  for (const candidate of candidates) {
    const distinctEnough = selected.every((color) => colorDistance(color, candidate.color) >= MIN_CANDIDATE_DISTANCE);
    if (!distinctEnough) {
      continue;
    }

    selected.push(candidate.color);
    if (selected.length === 3) {
      break;
    }
  }

  if (selected.length === 0) {
    return null;
  }

  while (selected.length < 3) {
    selected.push(createCompanionTone(selected[0], selected.length));
  }

  return [selected[0], selected[1], selected[2]];
}

function massageBackgroundTone(color: THREE.Color): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  const saturation = THREE.MathUtils.clamp(Math.max(hsl.s * 1.35, 0.46), 0.46, 0.82);
  const lightness = THREE.MathUtils.clamp(hsl.l + 0.08, 0.42, 0.66);
  return new THREE.Color().setHSL(hsl.h, saturation, lightness);
}

function createCompanionTone(source: THREE.Color, index: number): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  source.getHSL(hsl);
  const hueOffset = index === 1 ? 0.075 : -0.065;
  return new THREE.Color().setHSL(
    THREE.MathUtils.euclideanModulo(hsl.h + hueOffset, 1),
    THREE.MathUtils.clamp(hsl.s * (index === 1 ? 0.92 : 0.82), 0.38, 0.76),
    THREE.MathUtils.clamp(hsl.l + (index === 1 ? 0.04 : -0.03), 0.38, 0.68),
  );
}

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
