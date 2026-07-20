import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, MeshStandardMaterial, Object3D, Quaternion, Vector3 } from 'three';
import type { BoneId, MeshId, MorphTargetId } from '../../core/contracts';
import { makeMorphMesh } from './profileTestScene';
import { ThreeFrameApplier } from './ThreeFrameApplier';

const meshId = (value: number) => value as MeshId;
const morphTargetId = (value: number) => value as MorphTargetId;
const boneId = (value: number) => value as BoneId;

describe('ThreeFrameApplier', () => {
  it('applies batched morph, bone, and visibility frame deltas', () => {
    const root = new Object3D();
    const face = makeMorphMesh('FaceMesh', ['Smile', 'Blink']);
    const head = new Object3D();
    head.name = 'Head';
    root.add(face, head);

    const applier = new ThreeFrameApplier({
      meshes: new Map([[meshId(1), face]]),
      morphTargets: new Map([
        [morphTargetId(10), { meshId: meshId(1), mesh: face, index: 1 }],
      ]),
      bones: new Map([[boneId(20), head]]),
    });

    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
    applier.applyFrameDelta(root, {
      morphTargets: [
        { meshId: meshId(1), morphTargetId: morphTargetId(10), value: 0.75 },
      ],
      bones: [
        {
          boneId: boneId(20),
          transform: {
            position: { x: 1, y: 2, z: 3 },
            rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
          },
        },
      ],
      meshes: [
        { meshId: meshId(1), visible: false },
      ],
    });

    expect(face.morphTargetInfluences?.[1]).toBe(0.75);
    expect(face.visible).toBe(false);
    expect(head.position.toArray()).toEqual([1, 2, 3]);
    expect(head.quaternion.angleTo(rotation)).toBeLessThan(1e-6);
  });

  it('supports additive frame values', () => {
    const root = new Object3D();
    const face = makeMorphMesh('FaceMesh', ['Smile']);
    const head = new Object3D();
    root.add(face, head);
    face.morphTargetInfluences![0] = 0.2;
    head.position.set(1, 1, 1);

    const applier = new ThreeFrameApplier({
      morphTargets: new Map([
        [morphTargetId(10), { meshId: meshId(1), mesh: face, index: 0 }],
      ]),
      bones: new Map([[boneId(20), head]]),
    });

    applier.applyFrameDelta(root, {
      morphTargets: [
        { meshId: meshId(1), morphTargetId: morphTargetId(10), value: 0.3, mode: 'additive' },
      ],
      bones: [
        {
          boneId: boneId(20),
          mode: 'additive',
          transform: { position: { x: 2, y: 0, z: -1 } },
        },
      ],
    });

    expect(face.morphTargetInfluences?.[0]).toBeCloseTo(0.5);
    expect(head.position.toArray()).toEqual([3, 1, 0]);
  });

  it('applies packed morph frame deltas by morph target id', () => {
    const face = makeMorphMesh('FaceMesh', ['Smile', 'Blink']);
    const applier = new ThreeFrameApplier({
      morphTargets: new Map([
        [morphTargetId(10), { meshId: meshId(1), mesh: face, index: 1 }],
      ]),
    });

    applier.applyPackedMorphFrameDelta(new Float32Array([1, 10, 0.4, 0]));
    expect(face.morphTargetInfluences?.[1]).toBeCloseTo(0.4);
  });

  it('centralizes direct morph target array writes', () => {
    const infl = [0, 0, 0];
    const applier = new ThreeFrameApplier();

    applier.applyMorphTargets([{ infl, idx: 2 }], 0.9);
    expect(infl).toEqual([0, 0, 0.9]);

    applier.resetMorphTargets([{ infl, idx: 2 }]);
    expect(infl).toEqual([0, 0, 0]);
  });

  it('applies visibility, highlight, and material settings by mesh name', () => {
    const root = new Object3D();
    const material = new MeshStandardMaterial({
      emissive: 0x000000,
      emissiveIntensity: 0.1,
    });
    const face = makeMorphMesh('FaceMesh', ['Smile']);
    face.material = material;
    root.add(face);

    const applier = new ThreeFrameApplier();
    applier.setMeshVisible(root, 'FaceMesh', false);
    applier.highlightMesh(root, 'FaceMesh', 0xff0000, 0.75);
    applier.setMeshMaterialConfig(root, 'FaceMesh', {
      renderOrder: 9,
      opacity: 0.4,
      depthWrite: false,
      blending: 'Additive',
    });

    expect(face.visible).toBe(false);
    expect(material.emissive.getHex()).toBe(0xff0000);
    expect(material.emissiveIntensity).toBe(0.75);
    expect(applier.getMeshMaterialConfig(root, 'FaceMesh')).toMatchObject({
      renderOrder: 9,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: 'Additive',
    });

    applier.highlightMesh(root, null);
    expect(material.emissive.getHex()).toBe(0x000000);
    expect(material.emissiveIntensity).toBe(0.1);
  });

  it('ignores meshes without compatible material features', () => {
    const root = new Object3D();
    const face = makeMorphMesh('FaceMesh', ['Smile']);
    face.material = new MeshBasicMaterial();
    root.add(face);

    const applier = new ThreeFrameApplier();
    expect(() => applier.highlightMesh(root, 'FaceMesh')).not.toThrow();
  });
});
