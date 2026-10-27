import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { ThreeAnnotationController } from '../ThreeAnnotationController';
import { installAnnotationDom } from './annotationDom';

let controller: ThreeAnnotationController | null = null;
afterEach(() => { controller?.dispose(); controller = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('renders Rust labels, selection and expansion in both native views and releases their resources', async () => {
  const { domElement, host } = installAnnotationDom(); const scene = new THREE.Scene(); const selected = vi.fn();
  controller = new ThreeAnnotationController({ scene, camera: new THREE.PerspectiveCamera(45, 4 / 3), domElement, showDOMControls: false, onRegionSelect: selected });
  const model = new THREE.Group(); model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.4)));
  controller.setModel(model); controller.setMarkersVisible(true);
  controller.prepareRegionsForReveal({ characterId: 'views', regions: [
    { name: 'head', label: 'Head', children: ['eye'], markerAnchor: { type: 'point', position: { x: 0, y: 0.7, z: 0.4 } } },
    { name: 'eye', parent: 'head', markerAnchor: { type: 'point', position: { x: 0.2, y: 0.8, z: 0.4 } } },
  ] });
  await controller.loadMarkersForCurrentRegions();
  const native = [...(scene.children[0] as THREE.Group).children];
  const materials = native.flatMap(object => (object as THREE.Mesh).material ? [(object as THREE.Mesh).material as THREE.Material] : []);
  const release = materials.map(material => vi.spyOn(material, 'dispose'));
  controller.setMarkerStyle('html');
  release.forEach(dispose => expect(dispose).toHaveBeenCalledOnce());
  const overlay = host.children[0]; const parent = overlay.children.find(element => element.dataset.annotation === 'head')!;
  expect(parent.title).toBe('Head'); expect(parent.textContent).toBe('+'); expect(parent.style.display).toBe('flex');
  parent.dispatchEvent(new Event('click'));
  expect(selected).toHaveBeenCalledExactlyOnceWith('head');
  expect(controller.getExpandedRegions()).toEqual([{ regionName: 'head', isExpanded: true, children: ['eye'] }]);
  expect(overlay.children.find(element => element.dataset.annotation === 'head')!.textContent).toBe('−');
  controller.setCurrentRegion('eye'); controller.update();
  expect(overlay.children.find(element => element.dataset.annotation === 'eye')!.style.background).toBe('#63b3ed');
  controller.clearMarkers(); expect(overlay.children).toHaveLength(0);
  controller.dispose(); expect(host.children).toHaveLength(0); expect(scene.children).toHaveLength(0);
});
