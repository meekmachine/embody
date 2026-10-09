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
  scene.traverse(object => {
    const material = (object as THREE.Mesh).material;
    if (material) materials.push(...(Array.isArray(material) ? material : [material]));
  });
  return { controller, materials, tick(time: number) { now = time; controller!.update(); } };
}

describe('Rust marker fade material updates', () => {
  it.each([false, true])('preserves native programs when fading or interrupting a hide (interrupt=%s)', async interrupted => {
    const { controller, materials, tick } = await fadeFixture();
    expect(materials).toHaveLength(4);
    const versions = materials.map(material => material.version);
    const opacity = materials.map(material => material.opacity);
    controller.setMarkersVisible(false);
    tick(80);
    expect(materials.some((material, index) => material.opacity < opacity[index])).toBe(true);
    if (!interrupted) tick(300);
    controller.setMarkersVisible(true);
    tick(600);
    expect(materials.map(material => material.opacity)).toEqual(opacity);
    expect(materials.map(material => material.version)).toEqual(versions);
    expect(materials.every(material => material.transparent)).toBe(true);
  });
});
