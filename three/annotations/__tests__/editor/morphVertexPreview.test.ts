import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  buildMorphVertexPreviewRenderData,
  buildMorphVertexPreviewSample,
  resolveMorphPreviewMeshes,
  MorphVertexPreview,
} from '../../../editor/morphVertexPreview';

function createPreviewMesh(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      2, 0, 0,
    ], 3),
  );
  geometry.morphAttributes.position = [
    new THREE.Float32BufferAttribute([
      0, 0, 0,
      0, 0.5, 0,
      0, 0.02, 0,
    ], 3),
  ];
  geometry.morphTargetsRelative = true;

  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = 'FaceMesh';
  mesh.morphTargetDictionary = { Smile: 0 };
  mesh.morphTargetInfluences = [1];
  mesh.position.set(1, 2, 3);
  mesh.updateMatrixWorld(true);
  return mesh;
}

describe('morphVertexPreview', () => {
  it('filters morph vertices by displacement threshold', () => {
    const mesh = createPreviewMesh();

    const sample = buildMorphVertexPreviewSample(mesh, 'Smile', { threshold: 0.1 });

    expect(sample).not.toBeNull();
    expect(Array.from(sample?.indices ?? [])).toEqual([1]);
    expect(sample?.intensities[0]).toBeCloseTo(1);
  });

  it('resolves only meshes that contain the requested morph target', () => {
    const root = new THREE.Group();
    const targetMesh = createPreviewMesh();
    const otherMesh = createPreviewMesh();
    otherMesh.name = 'OtherMesh';
    otherMesh.morphTargetDictionary = { Frown: 0 };

    root.add(targetMesh, otherMesh);

    expect(resolveMorphPreviewMeshes(root, 'Smile').map((mesh) => mesh.name)).toEqual(['FaceMesh']);
    expect(resolveMorphPreviewMeshes(root, 'Smile', [])).toEqual([]);
    expect(resolveMorphPreviewMeshes(root, 'Smile', ['OtherMesh'])).toEqual([]);
  });

  it('builds world-space preview points from the current morphed mesh positions', () => {
    const mesh = createPreviewMesh();

    const data = buildMorphVertexPreviewRenderData([mesh], 'Smile', new Map(), { threshold: 0.1 });

    expect(data).not.toBeNull();
    expect(data?.pointCount).toBe(1);
    expect(Array.from(data?.positions ?? [])).toEqual([2, 2.5, 3]);
    expect(data?.meshCount).toBe(1);
  });

  it('reuses frame arrays while updating the current morphed positions', () => {
    const mesh = createPreviewMesh();
    const cache = new Map();
    const first = buildMorphVertexPreviewRenderData([mesh], 'Smile', cache, { threshold: 0.1 })!;
    mesh.morphTargetInfluences![0] = 0.5;
    const next = buildMorphVertexPreviewRenderData([mesh], 'Smile', cache, { threshold: 0.1 }, first)!;
    expect(next.positions).toBe(first.positions);
    expect(next.colors).toBe(first.colors);
    expect(Array.from(next.positions)).toEqual([2, 2.25, 3]);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });

  it('releases old GPU attributes before replacing differently sized samples', () => {
    const scene = new THREE.Scene();
    const mesh = createPreviewMesh();
    scene.add(mesh);
    const preview = new MorphVertexPreview(scene, { threshold: 0.1 });
    preview.show('Smile');
    const points = scene.getObjectByName('MorphVertexPreviewPoints') as THREE.Points<THREE.BufferGeometry>;
    const position = points.geometry.getAttribute('position');
    const color = points.geometry.getAttribute('color');
    const onDispose = vi.fn(() => {
      expect(points.geometry.getAttribute('position')).toBe(position);
      expect(points.geometry.getAttribute('color')).toBe(color);
    });
    points.geometry.addEventListener('dispose', onDispose);
    preview.hide();
    mesh.geometry.morphAttributes.position[0].setY(2, 0.5);
    preview.show('Smile');
    expect(onDispose).toHaveBeenCalledOnce();
    expect(points.geometry.getAttribute('position').count).toBe(2);
    expect(points.geometry.getAttribute('position')).not.toBe(position);
    points.geometry.removeEventListener('dispose', onDispose);
    preview.dispose();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });

  it('resamples a previous morph after another hover or a hidden preview', () => {
    const scene = new THREE.Scene();
    const mesh = createPreviewMesh();
    mesh.morphTargetDictionary!.Frown = 1;
    mesh.geometry.morphAttributes.position.push(mesh.geometry.morphAttributes.position[0].clone());
    mesh.morphTargetInfluences!.push(0);
    scene.add(mesh);
    const preview = new MorphVertexPreview(scene, { threshold: 0.1 });
    const samples = mesh.geometry.morphAttributes.position[0];
    preview.show('Smile');
    const points = scene.getObjectByName('MorphVertexPreviewPoints') as THREE.Points<THREE.BufferGeometry>;
    expect(points.geometry.getAttribute('position').getX(0)).toBe(2);
    preview.show('Frown');
    samples.setY(1, 0); samples.setY(2, 0.5);
    preview.show('Smile');
    expect(points.geometry.getAttribute('position').getX(0)).toBe(3);
    preview.hide();
    samples.setY(1, 0.5); samples.setY(2, 0);
    preview.show('Smile');
    expect(points.geometry.getAttribute('position').getX(0)).toBe(2);
    preview.dispose();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });

  it('updates the owned overlay in the existing scene render callback and releases it on close', () => {
    const scene = new THREE.Scene();
    const mesh = createPreviewMesh();
    scene.add(mesh);
    const previous = vi.fn();
    scene.onBeforeRender = previous;
    const preview = new MorphVertexPreview(scene, { threshold: 0.1 });
    preview.show('Smile', ['FaceMesh']);
    const points = scene.getObjectByName('MorphVertexPreviewPoints') as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    expect(points.visible).toBe(true);
    expect(Array.from(points.geometry.getAttribute('position').array)).toEqual([2, 2.5, 3]);
    mesh.morphTargetInfluences![0] = 0.5;
    Reflect.apply(scene.onBeforeRender, scene, []);
    expect(previous).toHaveBeenCalledOnce();
    expect(Array.from(points.geometry.getAttribute('position').array)).toEqual([2, 2.25, 3]);

    preview.hide();
    expect(points.visible).toBe(false);
    expect(scene.onBeforeRender).toBe(previous);
    preview.show('Smile', ['FaceMesh']);
    expect(scene.getObjectByName('MorphVertexPreviewPoints')).toBe(points);
    const disposeGeometry = vi.spyOn(points.geometry, 'dispose');
    const disposeMaterial = vi.spyOn(points.material, 'dispose');
    preview.dispose();
    preview.dispose();
    preview.show('Smile');
    expect(scene.getObjectByName('MorphVertexPreviewPoints')).toBeUndefined();
    expect(scene.children).toEqual([mesh]);
    expect(scene.onBeforeRender).toBe(previous);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
  });

  it('keeps an explicitly empty mesh selection clear and preserves other active previews', () => {
    const scene = new THREE.Scene();
    const mesh = createPreviewMesh();
    scene.add(mesh);
    const previous = scene.onBeforeRender;
    const first = new MorphVertexPreview(scene);
    const second = new MorphVertexPreview(scene);
    first.show('Smile', []);
    expect(scene.children).toEqual([mesh]);
    expect(scene.onBeforeRender).toBe(previous);
    first.show('Smile');
    second.show('Smile');
    first.dispose();
    expect(scene.onBeforeRender).not.toBe(previous);
    second.hide();
    expect(scene.onBeforeRender).toBe(previous);
    second.dispose();
    expect(scene.children).toEqual([mesh]);
  });
});
