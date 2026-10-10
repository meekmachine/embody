import type { ThreeAnnotationController } from './ThreeAnnotationController';
import type { MarkerStyle } from './types';
import { AnnotationLifecycleBridge } from './lifecycleBridge';
import { annotationQuery } from './runtime';
export const DEFAULT_MARKER_AUTO_HIDE_MS = 5000;
export type MarkerLifecycleRevealOptions = { durationMs?: number; markerStyle?: MarkerStyle; revealDelayMs?: number };
export type MarkerLifecycleRevealSource = { markerStyle?: MarkerStyle; playIntroOnLoad?: boolean };
type Controller = Pick<ThreeAnnotationController, 'setMarkersVisible' | 'setMarkerStyle'>;
export function createMarkerLifecycleRevealOptions(config: MarkerLifecycleRevealSource | null | undefined): MarkerLifecycleRevealOptions { return annotationQuery('revealOptions', { config }); }
export function createMarkerVisibilityLifecycle(getController: () => Controller | null, defaultDurationMs = DEFAULT_MARKER_AUTO_HIDE_MS) {
  let owner: Controller | null = null;
  const bridge = new AnnotationLifecycleBridge('visibility', defaultDurationMs, effects => {
    // Controller identity is a borrowed native resource, never serialized state.
    if (getController() !== owner) return;
    for (const effect of effects) { if (effect.kind === 'visibility') owner?.setMarkersVisible(effect.visible!); if (effect.kind === 'style') owner?.setMarkerStyle(effect.style!); }
  });
  const dispatch = (operation: string, options: unknown = {}) => { owner = getController(); bridge.dispatch(operation, options); };
  return { get ready() { return bridge.ready; }, setManualVisibility: (visible: boolean) => dispatch('manual', { visible }), prepareForCharacterLoad: () => dispatch('prepare'), showForCharacterLoad: (options: MarkerLifecycleRevealOptions = {}) => dispatch('reveal', options), dispose: () => bridge.dispatch('dispose') };
}
