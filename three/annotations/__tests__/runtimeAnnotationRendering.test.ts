import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireInitializedEmbodyCore } from '@lovelace_lol/embody/wasm';
import { ThreeAnnotationRenderer } from '../ThreeAnnotationRenderer';
import type { AnnotationSnapshot, MarkerDescriptor } from '../runtime';
import { installAnnotationDom } from './annotationDom';

const releases: Array<() => void> = [];
afterEach(() => {
  releases.splice(0).reverse().forEach(release => release());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function marker(id: number, runtimePreview: boolean): MarkerDescriptor {
  return {
    id, name: `target-${id}`, runtimePreview, label: 'Target', title: 'Target', htmlText: String(id),
    radius: 0.008, arrowLength: 0.02, arrowRadius: 0.008,
    style: {
      markerColor: 0x4299e1, markerRadius: 0.008, lineColor: 0x4299e1,
      labelColor: '#ffffff', labelBackground: '#000000', labelFontSize: 32,
      opacity: 1, lineDirection: 'radial',
      line: { style: 'dashed', curve: 'straight', arrowHead: true, thickness: 2, length: 0.5 },
    },
  };
}

function fixture(style: '3d' | 'html' = '3d') {
  const { domElement } = installAnnotationDom();
  const scene = new THREE.Scene();
  const hairGroup = new THREE.Group(); hairGroup.renderOrder = 100_000;
  const hair = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ transparent: true }));
  hair.renderOrder = 1_000_000; hairGroup.add(hair); scene.add(hairGroup);
  const runtime = new (requireInitializedEmbodyCore().AnnotationRuntime)('{}');
  const renderer = new ThreeAnnotationRenderer(runtime, scene, new THREE.PerspectiveCamera(), domElement, () => {}, () => {});
  releases.push(() => { renderer.dispose(); runtime.dispose(); runtime.free(); hair.geometry.dispose(); hair.material.dispose(); });
  const sync = (descriptors: MarkerDescriptor[], revision: number) => renderer.sync({
    ...(JSON.parse(runtime.snapshot()) as AnnotationSnapshot),
    style, descriptorRevision: revision, descriptors,
  });
  const objects = (id: number) => {
    const result: Array<THREE.Mesh<THREE.BufferGeometry, THREE.Material> | THREE.Line<THREE.BufferGeometry, THREE.Material> | THREE.Sprite> = [];
    scene.traverse(object => {
      if (object.userData.annotationId === id) result.push(object as typeof result[number]);
    });
    return result;
  };
  return { hair, hairGroup, scene, renderer, sync, objects };
}

describe('transient annotation rendering', () => {
  it.each(['3d', 'html'] as const)('layers %s preview resources above high-order hair while retaining saved marker depth', style => {
    const f = fixture(style);
    f.sync([marker(1, false), marker(2, true)], 1);
    const preview = f.objects(2); const saved = f.objects(1);
    expect(preview).toHaveLength(4); expect(saved).toHaveLength(4);
    for (const object of preview) {
      expect(object.parent?.renderOrder).toBeGreaterThan(f.hairGroup.renderOrder);
      expect(object.renderOrder).toBeGreaterThan(f.hair.renderOrder);
      expect(object.material.depthTest).toBe(false);
      expect(object.material.depthWrite).toBe(false);
    }
    for (const object of saved) {
      expect(object.parent?.renderOrder).toBe(0);
      expect(object.renderOrder).toBe(0);
      expect(object.material.depthTest).toBe(true);
      expect(object.material.depthWrite).toBe(!(object instanceof THREE.Sprite));
    }
    expect(f.hair.material.depthTest).toBe(true);
    expect(f.hair.material.depthWrite).toBe(true);
  });

  it('releases preview resources from their render group without removing saved annotations', () => {
    const f = fixture();
    const saved = marker(1, false);
    f.sync([saved, marker(2, true)], 1);
    const savedObjects = f.objects(1); const preview = f.objects(2);
    const disposed = preview.map(object => vi.spyOn(object.material, 'dispose'));
    f.sync([saved], 2);
    expect(f.objects(2)).toHaveLength(0);
    expect(f.objects(1)).toEqual(savedObjects);
    preview.forEach(object => expect(object.parent).toBeNull());
    disposed.forEach(dispose => expect(dispose).toHaveBeenCalledOnce());
    f.renderer.dispose();
    expect(f.scene.children).toEqual([f.hairGroup]);
  });
});
