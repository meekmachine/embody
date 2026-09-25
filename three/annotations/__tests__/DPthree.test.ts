import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { DPthree } from '../DPthree';
import { DPthreeCameraController } from '../DPthreeCameraController';
import { DPthree3DMarkers } from '../DPthree3DMarkers';

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = new THREE.Vector3();
    update() {} dispose() {} addEventListener() {} removeEventListener() {}
  },
}));
afterEach(() => vi.restoreAllMocks());

it('the convenience facade uses one controller-owned marker layer and one update/disposal path', async () => {
  const scene = new THREE.Scene();
  const dp = new DPthree({ scene, camera: new THREE.PerspectiveCamera(), domElement: { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLElement });
  dp.setModel(new THREE.Group());
  const markerLoad = vi.spyOn(DPthree3DMarkers.prototype, 'loadRegions');
  const markerUpdate = vi.spyOn(DPthree3DMarkers.prototype, 'update');
  const controllerDispose = vi.spyOn(DPthreeCameraController.prototype, 'dispose');
  await dp.loadCharacter({ characterId: 'one-layer', regions: [] });
  expect(dp.controller.getMarkersVisible()).toBe(true);
  expect(markerLoad).toHaveBeenCalledTimes(1);
  expect(scene.children.filter(object => object instanceof THREE.Group)).toHaveLength(1);
  dp.update(); expect(markerUpdate).toHaveBeenCalledTimes(1);
  dp.setMarkersVisible(true); expect(dp.controller.getMarkersVisible()).toBe(true);
  dp.dispose(); expect(controllerDispose).toHaveBeenCalledTimes(1);
  expect(scene.children).toHaveLength(0);
});

it('retains marker style preference across loads and preserves selection overrides', async () => {
  const onRegionSelect = vi.fn();
  const dp = new DPthree({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), domElement: { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLElement, onRegionSelect });
  // Isolate forwarding from HTML document construction.
  vi.spyOn(dp.controller, 'loadRegions').mockResolvedValue();
  dp.setMarkerStyle('html');
  await dp.loadCharacter({ characterId: 'next' });
  expect(dp.controller.loadRegions).toHaveBeenCalledWith({ characterId: 'next', markerStyle: 'html' });
  const internal = dp.controller as any;
  internal.currentMarkerStyle = '3d';
  internal.ensureMarkersForCurrentStyle();
  internal.markers.onSelect('head');
  expect(onRegionSelect).toHaveBeenCalledWith('head');
  expect(dp.getCurrentRegion()).toBeNull();
  dp.dispose();
});
