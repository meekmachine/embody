import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreeAnnotations } from '../ThreeAnnotations';
import { ThreeAnnotationController } from '../ThreeAnnotationController';
import { installAnnotationDom } from './annotationDom';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('the renamed facade owns one native layer and releases only its resources', async () => {
  const { domElement, host } = installAnnotationDom();
  const scene = new THREE.Scene(); const model = new THREE.Group(); scene.add(model);
  const annotations = await ThreeAnnotations.create({ scene, camera: new THREE.PerspectiveCamera(), domElement });
  annotations.setModel(model);
  const dispose = vi.spyOn(ThreeAnnotationController.prototype, 'dispose');
  await annotations.loadCharacter({ characterId: 'single-layer', regions: [] });
  expect(annotations.controller.getMarkersVisible()).toBe(true);
  expect(scene.children).toHaveLength(2);
  expect(host.children).toHaveLength(1);
  annotations.update(); annotations.dispose();
  expect(dispose).toHaveBeenCalledOnce();
  expect(scene.children).toEqual([model]); expect(host.children).toHaveLength(0);
});
it('retains Rust marker-style preference across character loads', async () => {
  const { domElement } = installAnnotationDom();
  const annotations = new ThreeAnnotations({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), domElement });
  annotations.setModel(new THREE.Group()); annotations.setMarkerStyle('html');
  await annotations.loadCharacter({ characterId: 'next', regions: [] });
  expect(annotations.controller.getMarkerStyle()).toBe('html');
  expect(annotations.validateCharacter()).toMatchObject({ valid: true, meshes: { total: 0 } });
  annotations.dispose();
});
