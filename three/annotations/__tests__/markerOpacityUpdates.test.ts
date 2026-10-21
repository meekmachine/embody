import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAnnotationCameraCore } from '../annotationCameraCore';
import { DPthree3DMarkers } from '../DPthree3DMarkers';

beforeAll(async () => { await getAnnotationCameraCore(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function createFadeFixture() {
  const markers = new DPthree3DMarkers({
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    domElement: { addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement,
    onSelect() {},
  });
  const internals = markers as any;
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.8 }));
  const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false }));
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, opacity: 0.9 }));
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7 }));
  label.scale.set(0.1, 0.05, 1);
  internals.markerMeshes.set('head', sphere);
  internals.lineMeshes.set('head', line);
  internals.labelSprites.set('head', label);
  internals.arrowMeshes.set('head', arrow);
  internals.markerGroup.add(sphere, line, label, arrow);

  const materials = [sphere.material, line.material, label.material, arrow.material];
  const versions = materials.map(material => material.version);
  let now = 0;
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  return {
    markers, internals, materials, versions, label, frames,
    tick(time: number) {
      now = time;
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(now);
    },
  };
}

describe('marker fade material updates', () => {
  it('fades and restores sphere, line, label and arrow without invalidating already-transparent materials', () => {
    const fixture = createFadeFixture();
    const { markers, materials, versions, internals, label, frames } = fixture;
    const opacities = materials.map(material => material.opacity);
    const depthWrites = materials.map(material => material.depthWrite);
    markers.setVisible(false);
    fixture.tick(110);
    for (const [index, material] of materials.entries()) {
      expect(material.opacity).toBeGreaterThan(0);
      expect(material.opacity).toBeLessThan(opacities[index]);
    }
    fixture.tick(220);
    expect(internals.markerGroup.visible).toBe(false);
    expect(materials.map(material => material.opacity)).toEqual(opacities);
    expect(label.scale.toArray()).toEqual([0.1, 0.05, 1]);
    markers.setVisible(true);
    expect(materials.every(material => material.opacity === 0)).toBe(true);
    fixture.tick(330);
    fixture.tick(440);
    expect(internals.markerGroup.visible).toBe(true);
    expect(materials.map(material => material.opacity)).toEqual(opacities);
    expect(materials.map(material => material.version)).toEqual(versions);
    expect(materials.map(material => material.depthWrite)).toEqual(depthWrites);
    expect(materials.every(material => material.transparent)).toBe(true);
    expect(frames.size).toBe(0);
    markers.dispose();
  });

  it('restores opacity when a hide is replaced by show without marking the materials for recompilation', () => {
    const { markers, materials, versions, label, tick, frames } = createFadeFixture();
    const opacities = materials.map(material => material.opacity);
    markers.setVisible(false);
    tick(80);
    markers.setVisible(true);
    tick(300);
    expect(materials.map(material => material.opacity)).toEqual(opacities);
    expect(materials.map(material => material.version)).toEqual(versions);
    expect(label.scale.toArray()).toEqual([0.1, 0.05, 1]);
    expect(frames.size).toBe(0);
    markers.dispose();
  });

  it('invalidates an opaque material once when enabling transparency, including arrays with mixed modes', () => {
    const materials = [
      new THREE.MeshBasicMaterial({ transparent: false }),
      new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }),
      new THREE.SpriteMaterial({ transparent: false }),
    ];
    const versions = materials.map(material => material.version);
    const updates = DPthree3DMarkers.prototype as any;
    for (const opacity of [0.75, 0.5, 0, 1]) updates.setObjectOpacity({ material: materials }, opacity);
    expect(materials.map(material => material.version)).toEqual([versions[0] + 1, versions[1], versions[2] + 1]);
    expect(materials.every(material => material.transparent && material.opacity === 1)).toBe(true);
    expect(materials[1].depthWrite).toBe(false);
    for (const material of materials) material.dispose();
  });
});
