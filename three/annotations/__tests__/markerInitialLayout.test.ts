import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DPthree3DMarkers } from '../DPthree3DMarkers';
import { getAnnotationCameraCore } from '../annotationCameraCore';
import type { CharacterConfig } from '../types';

beforeAll(async () => { await getAnnotationCameraCore(); });
const active: DPthree3DMarkers[] = [];
afterEach(() => {
  active.splice(0).forEach(markers => markers.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(cameraDistance = 1.2) {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.z = cameraDistance;
  camera.updateMatrixWorld(true);
  const model = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
  const markers = new DPthree3DMarkers({
    scene: new THREE.Scene(), camera,
    domElement: {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      getBoundingClientRect: () => ({ width: 800, height: 800 }),
    } as unknown as HTMLElement,
    onSelect: vi.fn(),
  });
  active.push(markers);
  markers.setModel(model);
  const internals = markers as any;
  vi.spyOn(internals, 'getRegionCenterAndBox').mockReturnValue({ center: new THREE.Vector3(), box: new THREE.Box3() });
  vi.spyOn(internals, 'findPrimaryBone').mockReturnValue(null);
  vi.spyOn(internals, 'getOutwardDirection').mockReturnValue(new THREE.Vector3(1, 0, 0));
  vi.spyOn(internals, 'findSurfacePoint').mockReturnValue(new THREE.Vector3());
  vi.spyOn(internals, 'createLabelSprite').mockImplementation(() => {
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ sizeAttenuation: false }));
    label.scale.set(0.1, 0.04, 1);
    return label;
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const config: CharacterConfig = {
    characterId: 'initial-layout', characterName: 'Initial layout', modelPath: 'test.glb',
    regions: [{ name: 'first', bones: ['Head'], line: { length: 10 } }],
  };
  const expectFitted = (name: string, scaleX = 0.085) => {
    const label = internals.labelSprites.get(name) as THREE.Sprite;
    const projected = label.position.clone().project(camera);
    const bounds = internals.getViewportSafeBounds(label);
    expect(label.visible).toBe(true);
    expect(Math.abs(projected.x)).toBeLessThanOrEqual(bounds.safeX + 1e-6);
    expect(Math.abs(projected.y)).toBeLessThanOrEqual(bounds.safeY + 1e-6);
    expect(label.scale.x).toBeCloseTo(scaleX);
  };
  return { markers, internals, config, expectFitted };
}

describe('initial marker layout', () => {
  it('fits a marker before loadRegions returns, then fits an addition with a stationary camera', async () => {
    const { markers, internals, config, expectFitted } = fixture();
    await markers.loadRegions(config);
    expectFitted('first');
    const firstScale = internals.markerMeshes.get('first').scale.clone();
    markers.updateRegion('second', { bones: ['Head'], line: { length: 10 } });
    expectFitted('second');
    expect(internals.markerMeshes.get('second').scale.toArray()).toEqual(firstScale.toArray());
  });

  it('keeps distance-based sphere sizing outside the close-up range on additions', async () => {
    const { markers, internals, config, expectFitted } = fixture(3.2);
    await markers.loadRegions(config);
    expectFitted('first', 0.1);
    markers.updateRegion('second', { bones: ['Head'], line: { length: 10 } });
    expectFitted('second', 0.1);
    expect(internals.markerMeshes.get('first').scale.x).toBeCloseTo(2);
    expect(internals.markerMeshes.get('second').scale.x).toBeCloseTo(2);
  });

  it('captures fitted scales before a hidden marker starts its first reveal', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { markers, internals, config, expectFitted } = fixture();
    markers.setVisible(false);
    await markers.loadRegions(config);
    markers.setVisible(true);
    const state = internals.visibilityAnimationStates[0];
    expect(state.label.scale.x).toBeCloseTo(0.085);
    expect(internals.visibilityAnimationActive).toBe(true);
    internals.applyVisibilityAnimationStates(internals.visibilityAnimationStates, true, 0.68);
    expectFitted('first', 0.085 * 1.28);
    internals.applyVisibilityAnimationStates(internals.visibilityAnimationStates, true, 1);
    internals.stopVisibilityAnimation(true);
    expectFitted('first');
  });

  it('keeps additions hidden during reveal and fits them when layout resumes', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { markers, internals, config, expectFitted } = fixture();
    markers.setVisible(false);
    await markers.loadRegions(config);
    markers.setVisible(true);
    markers.updateRegion('second', { bones: ['Head'], line: { length: 10 } });
    expect(internals.labelSprites.get('second').visible).toBe(false);
    internals.stopVisibilityAnimation(true);
    markers.update();
    expectFitted('second');
  });

  it('fits again after endpoint separation without requiring camera movement', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    const { markers, internals, config, expectFitted } = fixture();
    // Make separation push endpoints beyond the viewport, just as a long line
    // can do after the first region has already established a camera snapshot.
    vi.spyOn(internals, 'separateOverlappingMarkers').mockImplementation(() => {
      for (const [name, endpoints] of internals.lineEndpoints) {
        internals.updateMarkerGeometry(name, endpoints.start, new THREE.Vector3(10, 0, 0));
      }
    });
    await markers.loadRegions({ ...config, regions: [
      ...config.regions!, { name: 'second', bones: ['Head'], line: { length: 10 } },
    ] });
    expectFitted('first');
    expectFitted('second');
  });
});
