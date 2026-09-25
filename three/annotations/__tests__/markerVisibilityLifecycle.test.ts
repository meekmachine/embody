import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DPthreeCameraController } from '../DPthreeCameraController';
import type { MarkerStyle } from '../types';
import {
  createMarkerLifecycleRevealOptions,
  createMarkerVisibilityLifecycle,
  DEFAULT_MARKER_AUTO_HIDE_MS,
} from '../markerVisibilityLifecycle';

class MockCameraController {
  styleChanges: MarkerStyle[] = [];
  visibilityChanges: boolean[] = [];

  setMarkersVisible(visible: boolean): void {
    this.visibilityChanges.push(visible);
  }

  setMarkerStyle(style: MarkerStyle): void {
    this.styleChanges.push(style);
  }
}

describe('createMarkerVisibilityLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows markers for the load window and auto-hides them when the timer expires', () => {
    const controller = new MockCameraController();
    const lifecycle = createMarkerVisibilityLifecycle(
      () => controller as Pick<DPthreeCameraController, 'setMarkersVisible' | 'setMarkerStyle'>,
      1_000,
    );

    lifecycle.showForCharacterLoad({ markerStyle: 'html' });

    expect(controller.styleChanges).toEqual(['html']);
    expect(controller.visibilityChanges).toEqual([true]);

    vi.advanceTimersByTime(999);
    expect(controller.visibilityChanges).toEqual([true]);

    vi.advanceTimersByTime(1);
    expect(controller.visibilityChanges).toEqual([true, false]);
  });

  it('uses the default auto-hide duration when no override is provided', () => {
    const controller = new MockCameraController();
    const lifecycle = createMarkerVisibilityLifecycle(
      () => controller as Pick<DPthreeCameraController, 'setMarkersVisible' | 'setMarkerStyle'>,
    );

    lifecycle.showForCharacterLoad();

    vi.advanceTimersByTime(DEFAULT_MARKER_AUTO_HIDE_MS - 1);
    expect(controller.visibilityChanges).toEqual([true]);

    vi.advanceTimersByTime(1);
    expect(controller.visibilityChanges).toEqual([true, false]);
  });

  it('cancels the pending auto-hide when visibility is changed manually or a new load starts', () => {
    const controller = new MockCameraController();
    const lifecycle = createMarkerVisibilityLifecycle(
      () => controller as Pick<DPthreeCameraController, 'setMarkersVisible' | 'setMarkerStyle'>,
      1_000,
    );

    lifecycle.showForCharacterLoad();
    lifecycle.setManualVisibility(true);
    vi.advanceTimersByTime(1_000);

    expect(controller.visibilityChanges).toEqual([true, true]);

    lifecycle.showForCharacterLoad();
    lifecycle.prepareForCharacterLoad();
    vi.advanceTimersByTime(1_000);

    expect(controller.visibilityChanges).toEqual([true, true, true, false]);
  });

  it('can delay the initial reveal before starting the auto-hide window', () => {
    const controller = new MockCameraController();
    const lifecycle = createMarkerVisibilityLifecycle(
      () => controller as Pick<DPthreeCameraController, 'setMarkersVisible' | 'setMarkerStyle'>,
      1_000,
    );

    lifecycle.showForCharacterLoad({ markerStyle: 'html', revealDelayMs: 500 });

    vi.advanceTimersByTime(499);
    expect(controller.styleChanges).toEqual([]);
    expect(controller.visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(controller.styleChanges).toEqual(['html']);
    expect(controller.visibilityChanges).toEqual([true]);

    vi.advanceTimersByTime(999);
    expect(controller.visibilityChanges).toEqual([true]);

    vi.advanceTimersByTime(1);
    expect(controller.visibilityChanges).toEqual([true, false]);
  });

  it('cancels a pending delayed reveal when visibility is changed manually', () => {
    const controller = new MockCameraController();
    const lifecycle = createMarkerVisibilityLifecycle(
      () => controller as Pick<DPthreeCameraController, 'setMarkersVisible' | 'setMarkerStyle'>,
      1_000,
    );

    lifecycle.showForCharacterLoad({ revealDelayMs: 500 });
    lifecycle.setManualVisibility(false);

    vi.advanceTimersByTime(500);
    expect(controller.visibilityChanges).toEqual([false]);
  });

  it('uses the shared auto-hide duration for character-load reveal options', () => {
    const controller = new MockCameraController();
    const lifecycle = createMarkerVisibilityLifecycle(
      () => controller as Pick<DPthreeCameraController, 'setMarkersVisible' | 'setMarkerStyle'>,
    );

    lifecycle.showForCharacterLoad(createMarkerLifecycleRevealOptions({
      markerStyle: 'html',
      playIntroOnLoad: false,
    }));

    vi.advanceTimersByTime(119);
    expect(controller.visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(controller.visibilityChanges).toEqual([true]);

    vi.advanceTimersByTime(DEFAULT_MARKER_AUTO_HIDE_MS - 1);
    expect(controller.visibilityChanges).toEqual([true]);

    vi.advanceTimersByTime(1);
    expect(controller.styleChanges).toEqual(['html']);
    expect(controller.visibilityChanges).toEqual([true, false]);
  });

  it('keeps the intro reveal delay while preserving the shared auto-hide duration', () => {
    const controller = new MockCameraController();
    const lifecycle = createMarkerVisibilityLifecycle(
      () => controller as Pick<DPthreeCameraController, 'setMarkersVisible' | 'setMarkerStyle'>,
    );

    lifecycle.showForCharacterLoad(createMarkerLifecycleRevealOptions({
      markerStyle: 'html',
      playIntroOnLoad: true,
    }));

    vi.advanceTimersByTime(4_499);
    expect(controller.visibilityChanges).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(controller.visibilityChanges).toEqual([true]);

    vi.advanceTimersByTime(DEFAULT_MARKER_AUTO_HIDE_MS - 1);
    expect(controller.visibilityChanges).toEqual([true]);

    vi.advanceTimersByTime(1);
    expect(controller.styleChanges).toEqual(['html']);
    expect(controller.visibilityChanges).toEqual([true, false]);
  });

  it('keeps the load reveal configured for intro characters', () => {
    expect(createMarkerLifecycleRevealOptions({
      markerStyle: 'html',
      playIntroOnLoad: true,
    })).toEqual({
      markerStyle: 'html',
      revealDelayMs: 4_500,
    });
    expect(createMarkerLifecycleRevealOptions({
      playIntroOnLoad: false,
    })).toEqual({
      markerStyle: '3d',
      revealDelayMs: 120,
    });
  });
});
