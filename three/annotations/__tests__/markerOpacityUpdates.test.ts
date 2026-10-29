import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreeAnnotationController } from '../ThreeAnnotationController';
import { installAnnotationDom } from './annotationDom';

let controller: ThreeAnnotationController | null = null;
afterEach(() => { controller?.dispose(); controller = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fadeFixture() {
  const { domElement } = installAnnotationDom();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const scene = new THREE.Scene();
  controller = await ThreeAnnotationController.create({ scene, camera: new THREE.PerspectiveCamera(45, 4 / 3), domElement, showDOMControls: false });
  controller.setModel(new THREE.Group());
  controller.setMarkersVisible(true);
  controller.prepareRegionsForReveal({ characterId: 'fade', regions: [{ name: 'point',
    markerAnchor: { type: 'point', position: { x: 0, y: 1, z: 0 } }, style: { line: { arrowHead: true } } }] });
  await controller.loadMarkersForCurrentRegions();
  const materials: THREE.Material[] = [];
  const markers: THREE.Object3D[] = [];
  scene.traverse(object => {
    const material = (object as THREE.Mesh).material;
    if (material) {
      markers.push(object);
      materials.push(...(Array.isArray(material) ? material : [material]));
    }
  });
  return { controller, materials, markers, advance(milliseconds: number) { now += milliseconds; controller!.update(); } };
}

describe('Rust marker fade material updates', () => {
  it.each([false, true])('preserves native programs when fading or interrupting a hide (interrupt=%s)', async interrupted => {
    const { controller, materials, markers, advance } = await fadeFixture();
    expect(materials).toHaveLength(4);
    const versions = materials.map(material => material.version);
    // Marker creation starts a fade-in at time zero. Measure the fully shown
    // state before testing a hide, and keep the clock monotonic for both paths.
    advance(300);
    const opacity = materials.map(material => material.opacity);
    expect(opacity.every(value => value > 0)).toBe(true);
    expect(markers.every(marker => marker.visible)).toBe(true);
    controller.setMarkersVisible(false);
    advance(80);
    materials.forEach((material, index) => {
      expect(material.opacity).toBeGreaterThan(0);
      expect(material.opacity).toBeLessThan(opacity[index]);
    });
    expect(markers.every(marker => marker.visible)).toBe(true);
    expect(materials.map(material => material.version)).toEqual(versions);
    if (!interrupted) {
      advance(220);
      expect(materials.every(material => material.opacity === 0)).toBe(true);
      expect(markers.every(marker => !marker.visible)).toBe(true);
    }
    controller.setMarkersVisible(true);
    advance(300);
    expect(markers.every(marker => marker.visible)).toBe(true);
    expect(materials.map(material => material.opacity)).toEqual(opacity);
    expect(materials.map(material => material.version)).toEqual(versions);
    expect(materials.every(material => material.transparent)).toBe(true);
  });
});
