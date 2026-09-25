import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DPthreeCameraController } from '../DPthreeCameraController';
import type { AnnotationCharacterConfig } from '../types';

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = new THREE.Vector3();
    update() {}
    dispose() {}
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function config(characterId = 'first'): AnnotationCharacterConfig {
  return { characterId, playIntroOnLoad: true, regions: [{ name: 'target' }] };
}

const controllers: DPthreeCameraController[] = [];
function fixture(resolveCharacterConfig = (value: AnnotationCharacterConfig) => Promise.resolve(value)) {
  const controller = new DPthreeCameraController({
    camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(),
    domElement: {} as HTMLElement, showDOMControls: false, resolveCharacterConfig,
  });
  controllers.push(controller);
  controller.setModel(new THREE.Group());
  const markers = vi.spyOn(controller, 'loadMarkersForCurrentRegions').mockResolvedValue(undefined);
  const intro = vi.spyOn(controller, 'playIntroAnimation').mockResolvedValue(undefined);
  return { controller, markers, intro };
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.restoreAllMocks();
});

describe('annotation controller load ownership', () => {
  it.each(['dispose', 'clear', 'model', 'prepare', 'prepareMarkers', 'newLoad'] as const)(
    '%s prevents a pending host resolver from restoring the old config', async (operation) => {
      const pending = deferred<AnnotationCharacterConfig>();
      const original = config();
      const replacement = config('replacement');
      const { controller, markers, intro } = fixture((value) => value === original ? pending.promise : Promise.resolve(value));
      const loading = controller.loadRegions(original);

      if (operation === 'dispose') controller.dispose();
      if (operation === 'clear') controller.clearMarkers();
      if (operation === 'model') controller.setModel(new THREE.Group());
      if (operation === 'prepare') controller.prepareRegionsForReveal(replacement);
      if (operation === 'prepareMarkers') await controller.prepareRegionsAndMarkersForReveal(replacement);
      if (operation === 'newLoad') await controller.loadRegions(replacement);
      const callsBeforeResolution = markers.mock.calls.length;
      const introsBeforeResolution = intro.mock.calls.length;

      pending.resolve(original);
      await loading;

      expect(controller.getCharacterConfig()).not.toBe(original);
      expect(markers).toHaveBeenCalledTimes(callsBeforeResolution);
      expect(intro).toHaveBeenCalledTimes(introsBeforeResolution);
      if (operation === 'prepare' || operation === 'prepareMarkers' || operation === 'newLoad') {
        expect(controller.getCharacterConfig()).toBe(replacement);
      }
    },
  );

  it.each(['dispose', 'clear', 'model', 'prepare', 'sameConfig', 'edit'] as const)(
    '%s prevents an old marker preparation from warming or starting the intro', async (operation) => {
      const pending = deferred<void>();
      const original = config();
      const { controller, markers, intro } = fixture();
      markers.mockImplementationOnce(() => pending.promise);
      const beforeReveal = vi.fn(async () => true);
      const loading = controller.prepareRegionsAndMarkersForReveal(original, beforeReveal);

      if (operation === 'dispose') controller.dispose();
      if (operation === 'clear') controller.clearMarkers();
      if (operation === 'model') controller.setModel(new THREE.Group());
      if (operation === 'prepare') controller.prepareRegionsForReveal(config('replacement'));
      if (operation === 'sameConfig') await controller.prepareRegionsAndMarkersForReveal(original);
      if (operation === 'edit') controller.updateAnnotationRegion('target', { label: 'Edited' });
      const introsBeforeResolution = intro.mock.calls.length;

      pending.resolve();
      await loading;

      expect(beforeReveal).not.toHaveBeenCalled();
      expect(intro).toHaveBeenCalledTimes(introsBeforeResolution);
    },
  );

  it.each(['dispose', 'clear', 'model', 'prepare'] as const)(
    '%s during host warmup prevents its late camera transition', async (operation) => {
      const pending = deferred<boolean>();
      const { controller, intro } = fixture();
      const beforeReveal = vi.fn(() => pending.promise);
      const loading = controller.prepareRegionsAndMarkersForReveal(config(), beforeReveal);
      await Promise.resolve();
      expect(beforeReveal).toHaveBeenCalledOnce();

      if (operation === 'dispose') controller.dispose();
      if (operation === 'clear') controller.clearMarkers();
      if (operation === 'model') controller.setModel(new THREE.Group());
      if (operation === 'prepare') controller.prepareRegionsForReveal(config('replacement'));
      const introsBeforeResolution = intro.mock.calls.length;
      pending.resolve(true);
      await loading;

      expect(intro).toHaveBeenCalledTimes(introsBeforeResolution);
    },
  );

  it('warms then starts the current character exactly once', async () => {
    const { controller, markers, intro } = fixture();
    const beforeReveal = vi.fn(async () => {
      expect(markers).toHaveBeenCalledOnce();
      expect(intro).not.toHaveBeenCalled();
      return true;
    });
    const original = config();
    await controller.prepareRegionsAndMarkersForReveal(original, beforeReveal);
    expect(controller.getCharacterConfig()).toBe(original);
    expect(beforeReveal).toHaveBeenCalledOnce();
    expect(intro).toHaveBeenCalledOnce();
  });

  it('allows summary configs without resolved regions', () => {
    const { controller } = fixture();
    controller.prepareRegionsForReveal({ characterId: 'summary' });
    expect(controller.getRegionNames()).toEqual([]);
    expect(() => controller.removeAnnotationRegion('absent')).not.toThrow();
  });

  it('does not create new marker resources through public load/visibility methods after disposal', async () => {
    const { controller, markers, intro } = fixture();
    controller.prepareRegionsForReveal(config());
    intro.mockClear();
    controller.dispose();
    await controller.loadRegions(config('late'));
    await controller.prepareRegionsAndMarkersForReveal(config('late'));
    controller.prepareRegionsForReveal(config('late'));
    controller.setMarkersVisible(true);
    controller.setMarkerStyle('html');
    expect(markers).not.toHaveBeenCalled();
    expect(intro).not.toHaveBeenCalled();
  });

  it.each(['model', 'clear', 'dispose'] as const)(
    '%s prevents pending marker work from publishing loaded state', async (operation) => {
      const { controller, markers } = fixture();
      markers.mockRestore();
      controller.prepareRegionsForReveal(config());
      const pending = deferred<void>();
      const markerRuntime = {
        loadRegions: vi.fn(() => pending.promise), setVisible: vi.fn(), setModel: vi.fn(),
        setCurrentRegion: vi.fn(), clear: vi.fn(), dispose: vi.fn(),
      };
      const internal = controller as unknown as {
        markers: typeof markerRuntime | null;
        markersLoaded: boolean;
        ensureMarkersForCurrentStyle: () => void;
      };
      vi.spyOn(internal, 'ensureMarkersForCurrentStyle').mockImplementation(() => { internal.markers = markerRuntime; });
      const loading = controller.loadMarkersForCurrentRegions(true);
      if (operation === 'model') controller.setModel(new THREE.Group());
      if (operation === 'clear') controller.clearMarkers();
      if (operation === 'dispose') controller.dispose();
      const visibleCalls = markerRuntime.setVisible.mock.calls.length;
      pending.resolve();
      await loading;
      expect(internal.markersLoaded).toBe(false);
      expect(markerRuntime.setVisible).toHaveBeenCalledTimes(visibleCalls);
    },
  );
});
