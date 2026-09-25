export const DEFAULT_PREVIEW_AUTO_CLEAR_MS = 1200;

export interface RuntimeAnnotationPreviewLifecycleOptions {
  getDisabled?: () => boolean;
  getAutoClearMs?: () => number | undefined;
  onPreviewStart?: () => void;
  onPreviewEnd?: () => void;
}

/** Framework-independent annotation preview lifetime; hosts supply input events. */
export function createRuntimeAnnotationPreviewLifecycle(options: RuntimeAnnotationPreviewLifecycleOptions) {
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const end = () => {
    clearTimer();
    if (!active) return;
    active = false;
    options.onPreviewEnd?.();
  };
  const scheduleEnd = () => {
    clearTimer();
    const duration = options.getAutoClearMs?.() ?? DEFAULT_PREVIEW_AUTO_CLEAR_MS;
    if (duration <= 0 || !active) return;
    timer = setTimeout(end, duration);
  };
  return {
    start(forceRefresh = false) {
      if (options.getDisabled?.()) return;
      const wasActive = active;
      active = true;
      if (!wasActive || forceRefresh) options.onPreviewStart?.();
      scheduleEnd();
    },
    end,
    scheduleEnd,
    isActive: () => active,
    dispose: end,
  };
}
