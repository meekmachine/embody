import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreeAnnotationController } from '../ThreeAnnotationController';
import type { AnnotationCharacterConfig } from '../types';
import { deferred, installAnnotationDom } from './annotationDom';

function config(characterId = 'first'): AnnotationCharacterConfig {
  return { characterId, defaultRegion: characterId, regions: [{ name: characterId, markerAnchor: { type: 'point', position: { x: 0, y: 1, z: 0 } }, focusTarget: { type: 'point', position: { x: 0, y: 1, z: 0 } } }] };
}
const controllers: ThreeAnnotationController[] = [];
function fixture(resolveCharacterConfig = (value: AnnotationCharacterConfig) => Promise.resolve(value)) {
  const { domElement } = installAnnotationDom();
  const controller = new ThreeAnnotationController({ camera: new THREE.PerspectiveCamera(), scene: new THREE.Scene(), domElement, showDOMControls: false, resolveCharacterConfig });
  controllers.push(controller); controller.setModel(new THREE.Group());
  const markers = vi.spyOn(controller, 'loadMarkersForCurrentRegions').mockResolvedValue(undefined);
  return { controller, markers };
}
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('native async work uses Rust load generations', () => {
  it.each(['dispose', 'clear', 'model', 'prepare', 'prepareMarkers', 'newLoad'] as const)('%s invalidates a pending profile resolver', async operation => {
    const pending = deferred<AnnotationCharacterConfig>(); const original = config(); const replacement = config('replacement');
    const { controller, markers } = fixture(value => value === original ? pending.promise : Promise.resolve(value));
    const loading = controller.loadRegions(original);
    if (operation === 'dispose') controller.dispose();
    if (operation === 'clear') controller.clearMarkers();
    if (operation === 'model') controller.setModel(new THREE.Group());
    if (operation === 'prepare') controller.prepareRegionsForReveal(replacement);
    if (operation === 'prepareMarkers') await controller.prepareRegionsAndMarkersForReveal(replacement);
    if (operation === 'newLoad') await controller.loadRegions(replacement);
    const calls = markers.mock.calls.length; const selected = controller.getCurrentRegion();
    pending.resolve(original); await loading;
    expect(controller.getCharacterConfig()?.characterId).not.toBe('first');
    expect(controller.getCurrentRegion()).toBe(selected); expect(markers).toHaveBeenCalledTimes(calls);
    if (operation === 'prepare' || operation === 'prepareMarkers' || operation === 'newLoad') expect(controller.getCharacterConfig()?.characterId).toBe('replacement');
  });
  it.each(['dispose', 'clear', 'model', 'prepare', 'sameConfig', 'edit'] as const)('%s invalidates pending marker preparation before host warmup', async operation => {
    const pending = deferred(); const original = config(); const { controller, markers } = fixture();
    markers.mockImplementationOnce(() => pending.promise); const warmup = vi.fn(async () => true);
    const loading = controller.prepareRegionsAndMarkersForReveal(original, warmup);
    if (operation === 'dispose') controller.dispose();
    if (operation === 'clear') controller.clearMarkers();
    if (operation === 'model') controller.setModel(new THREE.Group());
    if (operation === 'prepare') controller.prepareRegionsForReveal(config('replacement'));
    if (operation === 'sameConfig') await controller.prepareRegionsAndMarkersForReveal(original);
    if (operation === 'edit') controller.updateAnnotationRegion('first', { label: 'Edited' });
    const selected = controller.getCurrentRegion(); pending.resolve(); await loading;
    expect(warmup).not.toHaveBeenCalled(); expect(controller.getCurrentRegion()).toBe(selected);
  });
  it.each(['dispose', 'clear', 'model', 'prepare'] as const)('%s during host warmup prevents a late camera transition', async operation => {
    const pending = deferred<boolean>(); const { controller } = fixture(); const warmup = vi.fn(() => pending.promise);
    const loading = controller.prepareRegionsAndMarkersForReveal(config(), warmup); await Promise.resolve();
    expect(warmup).toHaveBeenCalledOnce(); expect(controller.getCurrentRegion()).toBeNull();
    if (operation === 'dispose') controller.dispose();
    if (operation === 'clear') controller.clearMarkers();
    if (operation === 'model') controller.setModel(new THREE.Group());
    if (operation === 'prepare') controller.prepareRegionsForReveal(config('replacement'));
    const selected = controller.getCurrentRegion(); pending.resolve(true); await loading;
    expect(controller.getCurrentRegion()).toBe(selected);
  });
  it('finishes markers and host warmup before Rust starts the configured focus', async () => {
    const { controller, markers } = fixture(); const selected = vi.fn(); controller.onRegionChange(selected);
    await controller.prepareRegionsAndMarkersForReveal(config(), async () => {
      expect(markers).toHaveBeenCalledOnce(); expect(controller.getCurrentRegion()).toBeNull(); return true;
    });
    expect(controller.getCurrentRegion()).toBe('first'); expect(selected).toHaveBeenCalledExactlyOnceWith('first');
  });
  it('does not allocate markers after disposal', async () => {
    const { controller, markers } = fixture(); controller.dispose();
    await controller.loadRegions(config()); await controller.prepareRegionsAndMarkersForReveal(config());
    controller.prepareRegionsForReveal(config()); controller.setMarkersVisible(true); controller.setMarkerStyle('html');
    expect(markers).not.toHaveBeenCalled();
  });
});
