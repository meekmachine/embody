import * as THREE from 'three';
import { createSceneInkBackgroundCss, type SceneInkCssPalette } from './sceneInkBackgroundStyle';

export type SceneInkBackgroundPalette = readonly [
  THREE.ColorRepresentation,
  THREE.ColorRepresentation,
  THREE.ColorRepresentation,
];

export type SceneInkBackground = {
  setPalette: (palette?: SceneInkBackgroundPalette | null) => void;
  dispose: () => void;
};

const toCssColor = (tone: THREE.ColorRepresentation) => `#${new THREE.Color(tone).getHexString()}`;

export function createSceneInkBackground(
  onBackgroundChange?: (background: string) => void,
): SceneInkBackground {
  let currentBackground = '';
  let disposed = false;

  const applyBackground = (palette?: SceneInkBackgroundPalette | null) => {
    if (disposed) return;
    const colors: SceneInkCssPalette | undefined = palette
      ? [toCssColor(palette[0]), toCssColor(palette[1]), toCssColor(palette[2])]
      : undefined;
    const background = createSceneInkBackgroundCss(colors);
    if (background === currentBackground) return;
    currentBackground = background;
    onBackgroundChange?.(background);
  };

  applyBackground();

  return {
    setPalette: applyBackground,
    dispose: () => {
      if (disposed) return;
      disposed = true;
    },
  };
}
