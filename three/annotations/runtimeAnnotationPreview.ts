import { AnnotationLifecycleBridge } from './lifecycleBridge';
export const DEFAULT_PREVIEW_AUTO_CLEAR_MS = 1200;
export interface RuntimeAnnotationPreviewLifecycleOptions { getDisabled?: () => boolean; getAutoClearMs?: () => number | undefined; onPreviewStart?: () => void; onPreviewEnd?: () => void; }
export function createRuntimeAnnotationPreviewLifecycle(options: RuntimeAnnotationPreviewLifecycleOptions) {
  const bridge = new AnnotationLifecycleBridge('preview', DEFAULT_PREVIEW_AUTO_CLEAR_MS, effects => {
    for (const effect of effects) { if (effect.kind === 'previewStart') options.onPreviewStart?.(); if (effect.kind === 'previewEnd') options.onPreviewEnd?.(); }
  });
  return { get ready() { return bridge.ready; },
    start: (forceRefresh = false) => bridge.dispatch('start', { forceRefresh, disabled: options.getDisabled?.(), durationMs: options.getAutoClearMs?.() }),
    end: () => bridge.dispatch('end'), scheduleEnd: () => bridge.dispatch('scheduleEnd', { durationMs: options.getAutoClearMs?.() }),
    isActive: () => bridge.isActive(), dispose: () => bridge.dispatch('dispose'),
  };
}
