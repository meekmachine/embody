import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreeAnnotationMarkers } from '../ThreeAnnotationMarkers';
import { HtmlAnnotationMarkers } from '../HtmlAnnotationMarkers';
import type { CharacterConfig } from '../types';
import { installAnnotationDom } from './annotationDom';

const views: ThreeAnnotationMarkers[] = [];
const meshes: THREE.Mesh[] = [];
afterEach(() => {
  views.splice(0).forEach(view => view.dispose());
  meshes.splice(0).forEach(mesh => {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) (mesh as THREE.SkinnedMesh).skeleton.dispose();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function model(skinned: boolean, relative = true) {
  const geometry = new THREE.BufferGeometry();
  const base = [-1, 0, 0, 1, 0, 0, 0, 1, 0];
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(base, 3));
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(
    base.map((value, index) => (relative ? 0 : value) + (index % 3 === 1 ? 0.3 : 0)), 3,
  )];
  geometry.morphTargetsRelative = relative;
  const material = new THREE.MeshBasicMaterial();
  const mesh = skinned ? new THREE.SkinnedMesh(geometry, material) : new THREE.Mesh(geometry, material);
  mesh.name = 'Body';
  mesh.morphTargetDictionary = { Raise: 0 };
  mesh.morphTargetInfluences = [0];
  const bone = new THREE.Bone();
  if (mesh instanceof THREE.SkinnedMesh) {
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
  }
  meshes.push(mesh);
  return { mesh, bone };
}

const config: CharacterConfig = {
  characterId: 'animated-anchors',
  regions: [{ name: 'animated', meshes: ['Body'],
    runtimeAnnotation: { targetType: 'au', target: '1', morphNames: ['Raise'] },
    style: { lineDirection: { x: 1, y: 0, z: 0 }, line: { length: 0.2 } },
  }],
};

function fixture(html: boolean, skinned: boolean, relative = true) {
  const dom = installAnnotationDom();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.z = 5;
  const native = model(skinned, relative);
  const parent = new THREE.Group();
  scene.add(parent); parent.add(native.mesh);
  const View = html ? HtmlAnnotationMarkers : ThreeAnnotationMarkers;
  const view = new View({ scene, camera, domElement: dom.domElement, onSelect: vi.fn() });
  views.push(view);
  view.setModel(native.mesh);
  const position = (expected: THREE.Vector3) => {
    const actual = view.getMarkerPosition('animated');
    expect(actual).not.toBeNull();
    expect(actual!.distanceTo(expected)).toBeLessThan(1e-5);
  };
  return { ...native, ...dom, scene, parent, view, position };
}

describe.each([false, true])('animated anchors (html=%s)', html => {
  it.each([false, true])('follows morph weights without rescanning geometry or rebuilding views (relative=%s)', async relative => {
    const f = fixture(html, false, relative);
    await f.view.loadRegions(config);
    f.position(new THREE.Vector3(0, 1 / 3, 0));
    const scan = vi.spyOn(f.mesh.geometry.getAttribute('position'), 'getComponent');
    const objects = [...f.scene.children];
    const elements = [...f.host.children];
    f.view.setCurrentRegion('animated');
    for (const influence of [0.25, 1, 0]) {
      f.mesh.morphTargetInfluences![0] = influence;
      f.view.update();
      f.position(new THREE.Vector3(0, 1 / 3 + 0.3 * influence, 0));
    }
    expect(scan).not.toHaveBeenCalled();
    expect(f.scene.children).toEqual(objects);
    expect(f.host.children).toEqual(elements);
  });

  it('follows skinning with a stationary mesh and composes morphs with parent transforms', async () => {
    const f = fixture(html, true);
    await f.view.loadRegions(config);
    const stationaryMatrix = f.mesh.matrixWorld.clone();
    f.bone.position.x = 0.4;
    f.view.update();
    expect(f.mesh.matrixWorld.equals(stationaryMatrix)).toBe(true);
    f.position(new THREE.Vector3(0.4, 1 / 3, 0));

    f.mesh.morphTargetInfluences![0] = 1;
    f.parent.position.set(4, 2, -1);
    f.parent.rotation.z = Math.PI / 2;
    f.parent.scale.set(2, 3, 1);
    f.view.update();
    f.position(new THREE.Vector3(0.4, 1 / 3 + 0.3, 0).applyMatrix4(f.mesh.matrixWorld));
  });

  it('drops cached observations when a region becomes an explicit point', async () => {
    const f = fixture(html, true);
    await f.view.loadRegions(config);
    f.view.repositionMarker('animated', new THREE.Vector3(2, 1, 0));
    f.view.setVisible(false); // Exclude HTML occlusion raycasts from the sampling assertion.
    const sample = vi.spyOn(f.mesh, 'getVertexPosition');
    f.mesh.morphTargetInfluences![0] = 1;
    f.bone.position.x = 2;
    f.view.update();
    f.position(new THREE.Vector3(2, 1, 0));
    expect(sample).not.toHaveBeenCalled();
  });

  it('stops sampling after clear, model replacement and disposal', async () => {
    const f = fixture(html, true);
    await f.view.loadRegions(config);
    const oldPose = vi.spyOn(f.mesh, 'getVertexPosition');
    f.view.clear(); f.view.update();
    expect(oldPose).not.toHaveBeenCalled();
    expect(f.view.getMarkerPosition('animated')).toBeNull();
    const replacement = model(false);
    f.view.setModel(replacement.mesh);
    await f.view.loadRegions(config);
    replacement.mesh.morphTargetInfluences![0] = 1;
    f.view.update();
    f.position(new THREE.Vector3(0, 1 / 3 + 0.3, 0));
    expect(oldPose).not.toHaveBeenCalled();
    const newPose = vi.spyOn(replacement.mesh, 'getVertexPosition');
    f.view.dispose(); f.view.update();
    expect(newPose).not.toHaveBeenCalled();
  });

  it('rebuilds the candidate plan when regions are reloaded after geometry changes', async () => {
    const f = fixture(html, false);
    await f.view.loadRegions(config);
    f.view.setVisible(false);
    const original = f.mesh.geometry.getAttribute('position');
    f.mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute([2, 0, 0, 4, 0, 0, 3, 1, 0], 3));
    f.mesh.geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3)];
    f.mesh.geometry.boundingBox = null;
    f.mesh.geometry.boundingSphere = null;
    const sample = vi.spyOn(f.mesh, 'getVertexPosition');
    f.view.update();
    expect(sample).not.toHaveBeenCalled();
    await f.view.loadRegions(config);
    expect(f.mesh.geometry.getAttribute('position')).not.toBe(original);
    f.mesh.morphTargetInfluences![0] = 0.5;
    f.view.update();
    f.position(new THREE.Vector3(3, 1 / 3 + 0.5, 0));
  });
});
