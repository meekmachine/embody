import * as THREE from 'three';
import { beforeAll, expect, it } from 'vitest';
import { detectAnnotationLaterality, initEmbodyCore, resolveBoneNames } from '../adapter';
import { boneResolutionProfile } from '../boneResolutionProfile';

beforeAll(async () => { await initEmbodyCore(); });

it('preserves bone resolution and laterality without serializing unrelated profile payloads', () => {
  const required = {
    bonePrefix: 'Rig_', boneSuffix: '', suffixPattern: '_\\d+$',
    boneNodes: { leftEye: 'Eye_L', rightEye: 'Eye_R' },
  };
  const full = {
    ...required,
    authoredMorphs: { toJSON() { throw new Error('vertex data must not cross the bone lookup boundary'); } },
    importedBakedAnimations: { toJSON() { throw new Error('clips must not cross the bone lookup boundary'); } },
  };
  const projected = boneResolutionProfile(full)!;
  expect(resolveBoneNames(['leftEye', 'rightEye'], projected))
    .toEqual(resolveBoneNames(['leftEye', 'rightEye'], required));
  const model = new THREE.Group();
  for (const [index, name] of resolveBoneNames(['leftEye', 'rightEye'], required).entries()) {
    const bone = new THREE.Bone(); bone.name = name; bone.position.x = index === 0 ? 1 : -1;
    model.add(bone);
  }
  const regions = [
    { name: 'left_eye', label: 'Left eye', bones: ['leftEye'] },
    { name: 'right_eye', label: 'Right eye', bones: ['rightEye'] },
  ];
  expect(detectAnnotationLaterality(model, regions, projected))
    .toEqual(detectAnnotationLaterality(model, regions, required));
  expect(() => JSON.stringify(projected)).not.toThrow();
  expect(full.authoredMorphs).toBeDefined();
});

it('reflects subsequent bone mapping edits without a stale profile cache', () => {
  const profile = { bonePrefix: 'Old_', boneNodes: { head: 'Head' } };
  boneResolutionProfile(profile);
  profile.bonePrefix = 'New_';
  profile.boneNodes = { head: 'Skull' };
  expect(resolveBoneNames(['head'], boneResolutionProfile(profile)!))
    .toEqual(resolveBoneNames(['head'], profile));
});
