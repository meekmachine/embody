// This definition is shared by the page, scene and loader. It must remain
// usable before Three.js, the character or its textures have loaded.
export const SCENE_INK_BASE_COLOR = '#29333b';
export const SCENE_INK_BASE_GRADIENT =
  'radial-gradient(ellipse at 50% 42%, #46535c 0%, #35414a 42%, #29333b 76%, #252e35 100%)';

export type SceneInkCssPalette = readonly [string, string, string];

const DEFAULT_PALETTE: SceneInkCssPalette = ['#7cb8b2', '#627888', '#8b989f'];

export function createSceneInkBackgroundCss(palette: SceneInkCssPalette = DEFAULT_PALETTE): string {
  const [a, b, c] = palette;
  // Overlapping soft ellipses give the ink irregular edges without a noise
  // shader, blur filter, canvas, pointer listener or frame-by-frame repaint.
  return [
    `radial-gradient(ellipse 46% 62% at calc(20% + var(--scene-ink-shift-x, 0%)) 30%, color-mix(in srgb, ${a} 24%, transparent), transparent 78%)`,
    `radial-gradient(ellipse 32% 44% at 34% calc(52% + var(--scene-ink-shift-y, 0%)), color-mix(in srgb, ${a} 12%, transparent), transparent 82%)`,
    `radial-gradient(ellipse 48% 60% at calc(82% - var(--scene-ink-shift-x, 0%)) 62%, color-mix(in srgb, ${b} 22%, transparent), transparent 80%)`,
    `radial-gradient(ellipse 28% 38% at 68% calc(26% - var(--scene-ink-shift-y, 0%)), color-mix(in srgb, ${b} 10%, transparent), transparent 82%)`,
    `radial-gradient(ellipse 50% 38% at 38% calc(78% + var(--scene-ink-shift-y, 0%)), color-mix(in srgb, ${c} 18%, transparent), transparent 82%)`,
    SCENE_INK_BASE_GRADIENT,
  ].join(', ');
}

export const DEFAULT_SCENE_INK_BACKGROUND = createSceneInkBackgroundCss();

/** Sample once at the page owner; progress updates never choose a new layout. */
export function createSceneInkVariation(seed: number): Record<string, string> {
  const bounded = Math.max(0, Math.min(1, seed));
  return {
    '--scene-ink-shift-x': `${((bounded - 0.5) * 12).toFixed(2)}%`,
    '--scene-ink-shift-y': `${((Math.sin(bounded * Math.PI * 2)) * 6).toFixed(2)}%`,
  };
}
