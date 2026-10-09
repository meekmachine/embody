import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { prepareModelSkinning } from '../../modelSkinning';
import { compileModelForRender } from '../modelRenderPreparation';

function skinnedTriangle() {
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex([0, 1, 2]);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3)];
  geometry.morphTargetsRelative = true;
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  const rootBone = new THREE.Bone();
  const posedBone = new THREE.Bone();
  rootBone.add(posedBone);
  mesh.add(rootBone);
  mesh.bind(new THREE.Skeleton([rootBone, posedBone]));
  mesh.morphTargetInfluences![0] = 0.5;
  posedBone.position.x = 2;
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
  return mesh;
}

describe('model skinning across renderer replacement', () => {
  it('retains indexed geometry, the animated pose, morphs and authored visibility', () => {
    const model = new THREE.Group();
    model.visible = false;
    const mesh = skinnedTriangle();
    mesh.visible = false;
    model.add(mesh);
    const { geometry, material, skeleton } = mesh;
    const index = geometry.index;
    const position = geometry.getAttribute('position');
    const weights = geometry.getAttribute('skinWeight');
    const morphs = geometry.morphAttributes.position;
    const before = Array.from({ length: 3 }, (_, vertex) => mesh.getVertexPosition(vertex, new THREE.Vector3()).toArray());

    prepareModelSkinning(model);

    expect(geometry.getAttribute('skinIndex').array).toBeInstanceOf(Float32Array);
    expect(mesh.geometry).toBe(geometry);
    expect(mesh.material).toBe(material);
    expect(mesh.skeleton).toBe(skeleton);
    expect(geometry.index).toBe(index);
    expect(geometry.getAttribute('position')).toBe(position);
    expect(geometry.getAttribute('skinWeight')).toBe(weights);
    expect(geometry.morphAttributes.position).toBe(morphs);
    expect(mesh.morphTargetInfluences).toEqual([0.5]);
    expect(mesh.parent).toBe(model);
    expect(model.visible).toBe(false);
    expect(mesh.visible).toBe(false);
    expect(before[0]).toEqual([1, 0.5, 0]);
    expect(Array.from({ length: 3 }, (_, vertex) => mesh.getVertexPosition(vertex, new THREE.Vector3()).toArray())).toEqual(before);
  });

  it.each([
    { name: 'Uint8', array: new Uint8Array([0, 1, 127, 255]) },
    { name: 'Uint16', array: new Uint16Array([0, 1, 32768, 65535]) },
    // Three's WebGPU upload widens the original integer joint attribute in place.
    { name: 'WebGPU-widened Uint32', array: new Uint32Array([0, 1, 32768, 65535]) },
  ])('retains exact $name joint indices in a float vertex input', ({ array }) => {
    const mesh = skinnedTriangle();
    const original = new THREE.BufferAttribute(array, 4);
    original.name = 'authored joints';
    original.setUsage(THREE.DynamicDrawUsage);
    mesh.geometry.setAttribute('skinIndex', original);

    prepareModelSkinning(mesh);

    const prepared = mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
    expect(prepared).not.toBe(original);
    expect(prepared.array).toBeInstanceOf(Float32Array);
    expect(Array.from(prepared.array)).toEqual(Array.from(array));
    expect(prepared.itemSize).toBe(4);
    expect(prepared.normalized).toBe(false);
    expect(prepared.gpuType).toBe(THREE.FloatType);
    expect(prepared.name).toBe(original.name);
    expect(prepared.usage).toBe(original.usage);
    expect(original.array).toBe(array);
  });

  it('extracts interleaved joints without changing the shared source buffer or other attributes', () => {
    const mesh = skinnedTriangle();
    const source = new Uint16Array([91, 0, 1, 2, 65535, 92, 3, 4, 5, 6]);
    const before = Array.from(source);
    const interleaved = new THREE.InterleavedBuffer(source, 5);
    const joints = new THREE.InterleavedBufferAttribute(interleaved, 4, 1);
    const other = new THREE.InterleavedBufferAttribute(interleaved, 1, 0);
    mesh.geometry.setAttribute('skinIndex', joints);
    mesh.geometry.setAttribute('authorTag', other);

    prepareModelSkinning(mesh);

    const prepared = mesh.geometry.getAttribute('skinIndex');
    expect(prepared).toBeInstanceOf(THREE.Float32BufferAttribute);
    expect(Array.from(prepared.array)).toEqual([0, 1, 2, 65535, 3, 4, 5, 6]);
    expect(prepared.count).toBe(2);
    expect(mesh.geometry.getAttribute('authorTag')).toBe(other);
    expect(joints.data).toBe(interleaved);
    expect(interleaved.array).toBe(source);
    expect(Array.from(source)).toEqual(before);
  });

  it('reuses one compatible attribute for shared geometry and repeated preparation', () => {
    const model = new THREE.Group();
    const first = skinnedTriangle();
    const second = new THREE.SkinnedMesh(first.geometry, first.material);
    model.add(first, second);
    prepareModelSkinning(model);
    const prepared = first.geometry.getAttribute('skinIndex');

    prepareModelSkinning(model);

    expect(first.geometry.getAttribute('skinIndex')).toBe(prepared);
    expect(second.geometry.getAttribute('skinIndex')).toBe(prepared);
  });

  it('keeps an existing float input and removes an explicit integer GPU binding when present', () => {
    const mesh = skinnedTriangle();
    const compatible = new THREE.Float32BufferAttribute([0, 1, 2, 3], 4);
    mesh.geometry.setAttribute('skinIndex', compatible);
    prepareModelSkinning(mesh);
    expect(mesh.geometry.getAttribute('skinIndex')).toBe(compatible);

    compatible.gpuType = THREE.IntType;
    prepareModelSkinning(mesh);

    const prepared = mesh.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
    expect(prepared).not.toBe(compatible);
    expect(prepared.gpuType).toBe(THREE.FloatType);
    expect(Array.from(prepared.array)).toEqual([0, 1, 2, 3]);
  });

  it('restores the exact previous renderer attribute after a failed switch', () => {
    const model = new THREE.Group();
    const first = skinnedTriangle();
    const original = new THREE.Uint32BufferAttribute([0, 1, 32768, 65535], 4);
    first.geometry.setAttribute('skinIndex', original);
    const second = new THREE.SkinnedMesh(first.geometry, first.material);
    model.add(first, second);

    const restore = prepareModelSkinning(model);
    expect(first.geometry.getAttribute('skinIndex')).not.toBe(original);
    restore();
    restore();

    expect(first.geometry.getAttribute('skinIndex')).toBe(original);
    expect(second.geometry.getAttribute('skinIndex')).toBe(original);
    expect(Array.from(original.array)).toEqual([0, 1, 32768, 65535]);
  });

  it('does not overwrite an attribute replaced by its owner while renderer preparation was pending', () => {
    const mesh = skinnedTriangle();
    const restore = prepareModelSkinning(mesh);
    const replacement = new THREE.Float32BufferAttribute([2, 3, 4, 5], 4);
    mesh.geometry.setAttribute('skinIndex', replacement);

    restore();

    expect(mesh.geometry.getAttribute('skinIndex')).toBe(replacement);
    expect(Array.from(replacement.array)).toEqual([2, 3, 4, 5]);
  });

  it.each([false, true])('prepares joints before model compilation (native=%s), including a rejected compile', async (native) => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const model = skinnedTriangle();
    model.visible = false;
    const failure = new Error('shader compilation failed');
    const renderer = {
      ...(native ? { isWebGPURenderer: true, hasInitialized: () => true } : {}),
      compileAsync: vi.fn(async () => {
        const joints = model.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
        expect(joints.array).toBeInstanceOf(Float32Array);
        expect(joints.gpuType).toBe(THREE.FloatType);
        throw failure;
      }),
    };

    await expect(compileModelForRender(renderer as unknown as THREE.WebGLRenderer, scene, camera, model)).rejects.toBe(failure);

    expect(renderer.compileAsync).toHaveBeenCalledExactlyOnceWith(model, camera, scene);
    expect(model.parent).toBeNull();
    expect(model.visible).toBe(false);
    const prepared = model.geometry.getAttribute('skinIndex');
    prepareModelSkinning(model);
    expect(model.geometry.getAttribute('skinIndex')).toBe(prepared);
  });
});
