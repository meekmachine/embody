import type { DPthreeCameraController } from './DPthreeCameraController';
import type { MarkerStyle } from './types';

export const DEFAULT_MARKER_AUTO_HIDE_MS = 5_000;
const INTRO_MARKER_REVEAL_DELAY_MS = 4_500;
const POST_LOAD_MARKER_REVEAL_DELAY_MS = 120;

export type MarkerLifecycleRevealOptions = {
  durationMs?: number;
  markerStyle?: MarkerStyle;
  revealDelayMs?: number;
};

export type MarkerLifecycleRevealSource = {
  markerStyle?: MarkerStyle;
  playIntroOnLoad?: boolean;
};

type MarkerLifecycleController = Pick<DPthreeCameraController, 'setMarkersVisible' | 'setMarkerStyle'>;

export function createMarkerLifecycleRevealOptions(
  config: MarkerLifecycleRevealSource | null | undefined,
): MarkerLifecycleRevealOptions {
  return {
    markerStyle: config?.markerStyle ?? '3d',
    revealDelayMs: config?.playIntroOnLoad ? INTRO_MARKER_REVEAL_DELAY_MS : POST_LOAD_MARKER_REVEAL_DELAY_MS,
  };
}

export function createMarkerVisibilityLifecycle(
  getController: () => MarkerLifecycleController | null,
  defaultDurationMs = DEFAULT_MARKER_AUTO_HIDE_MS,
) {
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let autoHideTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = () => {
    if (revealTimer) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }

    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }
  };

  return {
    setManualVisibility(visible: boolean): void {
      clearTimers();
      getController()?.setMarkersVisible(visible);
    },

    prepareForCharacterLoad(): void {
      clearTimers();
      getController()?.setMarkersVisible(false);
    },

    showForCharacterLoad(options: MarkerLifecycleRevealOptions = {}): void {
      clearTimers();

      const controller = getController();
      if (!controller) return;

      const reveal = () => {
        revealTimer = null;

        if (getController() !== controller) {
          return;
        }

        controller.setMarkerStyle(options.markerStyle ?? '3d');
        controller.setMarkersVisible(true);

        autoHideTimer = setTimeout(() => {
          autoHideTimer = null;

          if (getController() !== controller) {
            return;
          }

          controller.setMarkersVisible(false);
        }, options.durationMs ?? defaultDurationMs);
      };

      if (options.revealDelayMs && options.revealDelayMs > 0) {
        revealTimer = setTimeout(reveal, options.revealDelayMs);
        return;
      }

      reveal();
    },

    dispose(): void {
      clearTimers();
    },
  };
}
