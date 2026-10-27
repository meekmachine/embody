import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ThreeAnnotationMarkers } from '../ThreeAnnotationMarkers';
import { getAnnotationCameraCore } from '../annotationCameraCore';
import { AnnotationElement, installAnnotationDom } from './annotationDom';
import type { AnnotationAnchoredRegion, CharacterConfig } from '../types';

beforeAll(async () => { await getAnnotationCameraCore(); });
const active: ThreeAnnotationMarkers[] = [];
const models: THREE.Mesh[] = [];
afterEach(() => {
  active.splice(0).forEach(markers => markers.dispose());
  models.splice(0).forEach(model => {
    model.geometry.dispose();
    (model.material as THREE.Material).dispose();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function region(name: string, y = 0, length = 3): AnnotationAnchoredRegion {
  return {
    name, markerAnchor: { type: 'point', position: { x: 0, y, z: 0 } },
    style: { lineDirection: { x: 1, y: 0, z: 0 }, line: { length } },
  };
}

function fixture(cameraDistance = 1.2) {
  const dom = installAnnotationDom();
  dom.host.clientHeight = 800;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  // Retain the native label construction; only text metrics/drawing are fake.
  // A 12px font with these metrics produces a 75-by-30 label (aspect 2.5).
  vi.spyOn(AnnotationElement.prototype, 'getContext').mockReturnValue({
    measureText: () => ({ width: 51 }), fillRect() {}, fillText() {},
  });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.z = cameraDistance;
  camera.updateMatrixWorld(true);
  const scene = new THREE.Scene();
  const model = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
  models.push(model);
  const markers = new ThreeAnnotationMarkers({
    scene, camera, domElement: dom.domElement, onSelect: vi.fn(),
    config: { labelScale: 0.04, labelFontSize: 12 },
  });
  active.push(markers);
  markers.setModel(model);
  const config: CharacterConfig = { characterId: 'initial-layout', regions: [region('first')] };
  const labels = () => {
    const values: THREE.Sprite[] = [];
    scene.traverse(object => { if (object instanceof THREE.Sprite) values.push(object); });
    return values;
  };
  const spheres = () => {
    const values: THREE.Mesh[] = [];
    scene.traverse(object => {
      if (object instanceof THREE.Mesh && object.geometry instanceof THREE.SphereGeometry) values.push(object);
    });
    return values;
  };
  const expectFitted = (count: number, settledScaleX?: number) => {
    expect(labels()).toHaveLength(count);
    for (const label of labels()) {
      const projected = label.getWorldPosition(new THREE.Vector3()).project(camera);
      expect(label.visible).toBe(true);
      expect(label.scale.x).toBeGreaterThan(0);
      // Screen-space Sprite dimensions plus the 12px gutter must fit, including
      // reveal overshoot. This checks the rendered output, not private layout maps.
      const halfWidth = label.scale.x * camera.projectionMatrix.elements[0] / 2;
      const halfHeight = label.scale.y * camera.projectionMatrix.elements[5] / 2;
      expect(Math.abs(projected.x) + halfWidth).toBeLessThanOrEqual(1 - 24 / 800 + 1e-6);
      expect(Math.abs(projected.y) + halfHeight).toBeLessThanOrEqual(1 - 24 / 800 + 1e-6);
      if (settledScaleX !== undefined) expect(label.scale.x).toBeCloseTo(settledScaleX);
    }
    expect(camera.position.toArray()).toEqual([0, 0, cameraDistance]);
  };
  return { markers, config, labels, spheres, expectFitted,
    advance(milliseconds: number) { now += milliseconds; markers.update(); },
  };
}

describe('initial marker layout', () => {
  it('fits before loadRegions returns and after adding a marker without camera movement', async () => {
    const f = fixture();
    await f.markers.loadRegions(f.config);
    f.expectFitted(1);
    f.advance(220);
    f.expectFitted(1, 0.085);
    f.markers.updateRegion('second', region('second', 0.1));
    f.expectFitted(2);
    f.advance(220);
    f.expectFitted(2, 0.085);
    for (const sphere of f.spheres()) expect(sphere.scale.x).toBeCloseTo(0.25);
  });

  it('preserves distance-based sphere sizing outside close-up on additions', async () => {
    const f = fixture(3.2);
    await f.markers.loadRegions(f.config);
    f.expectFitted(1);
    f.markers.updateRegion('second', region('second', 0.1));
    f.expectFitted(2);
    f.advance(220);
    f.expectFitted(2, 0.1);
    for (const sphere of f.spheres()) expect(sphere.scale.x).toBeCloseTo(2);
  });

  it('hides excessively shortened lines under the Rust minimum-length rule', async () => {
    const f = fixture();
    await f.markers.loadRegions({ ...f.config, regions: [region('extreme', 0, 10)] });
    expect(f.labels()).toHaveLength(1);
    expect(f.labels()[0].visible).toBe(false);
    expect(f.spheres()[0].visible).toBe(false);
  });

  it('fits the first hidden-to-visible frame and its reveal overshoot', async () => {
    const f = fixture();
    f.markers.setVisible(false);
    await f.markers.loadRegions(f.config);
    expect(f.labels()[0].visible).toBe(false);
    f.markers.setVisible(true);
    f.expectFitted(1);
    f.advance(220 * 0.68);
    f.expectFitted(1, 0.085 * 1.28);
    f.advance(220 * 0.32);
    f.expectFitted(1, 0.085);
  });

  it('fits newly added markers while existing labels are revealing', async () => {
    const f = fixture();
    await f.markers.loadRegions(f.config);
    f.advance(220 * 0.68);
    f.expectFitted(1, 0.085 * 1.28);
    f.markers.updateRegion('second', region('second', 0.1));
    f.expectFitted(2);
    f.advance(220 * 0.68);
    f.expectFitted(2);
    f.advance(220);
    f.expectFitted(2, 0.085);
  });

  it('fits overlapping endpoints after Rust separates them without a camera move', async () => {
    const f = fixture();
    await f.markers.loadRegions({ ...f.config, regions: [region('first'), region('second')] });
    f.expectFitted(2);
    const [first, second] = f.labels();
    expect(first.position.distanceTo(second.position)).toBeGreaterThan(0);
    f.advance(220);
    f.expectFitted(2, 0.085);
  });
});
