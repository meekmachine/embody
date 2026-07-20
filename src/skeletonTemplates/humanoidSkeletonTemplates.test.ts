import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  computeHumanoidSkeletonTemplateRestBounds,
  createValidationSkeletonFromHumanoidTemplate,
  extractHumanoidSkeletonTemplateFromModel,
  getHumanoidSkeletonTemplate,
  getHumanoidSkeletonTemplateBoneNames,
  HUMANOID_SKELETON_TEMPLATES,
  JONATHAN_HUMANOID_SKELETON_TEMPLATE,
} from './humanoidSkeletonTemplates';

describe('humanoid skeleton templates', () => {
  it('loads the Jonathan template from the registry', () => {
    expect(HUMANOID_SKELETON_TEMPLATES.map((template) => template.id)).toContain('jonathan-cc-base');
    expect(getHumanoidSkeletonTemplate('jonathan-cc-base')).toBe(JONATHAN_HUMANOID_SKELETON_TEMPLATE);
    expect(getHumanoidSkeletonTemplate('missing-template')).toBeNull();
  });

  it('preserves the extracted Jonathan skin joint list', () => {
    expect(JONATHAN_HUMANOID_SKELETON_TEMPLATE).toMatchObject({
      id: 'jonathan-cc-base',
      sourceCharacterId: 'jonathan',
      sourceAsset: 'frontend/public/characters/jonathan_new.glb',
      sourceSkinName: 'Armature',
    });
    expect(JONATHAN_HUMANOID_SKELETON_TEMPLATE.bones).toHaveLength(101);
    expect(getHumanoidSkeletonTemplateBoneNames().slice(0, 6)).toEqual([
      'CC_Base_BoneRoot',
      'CC_Base_Hip',
      'CC_Base_Pelvis',
      'CC_Base_L_Thigh',
      'CC_Base_L_Calf',
      'CC_Base_L_Foot',
    ]);
  });

  it('validates parent links and expected CC4 facial bones', () => {
    const names = new Set(JONATHAN_HUMANOID_SKELETON_TEMPLATE.bones.map((bone) => bone.name));
    const rootBones = JONATHAN_HUMANOID_SKELETON_TEMPLATE.bones.filter((bone) => bone.parent === null);

    expect(rootBones.map((bone) => bone.name)).toEqual(['CC_Base_BoneRoot']);
    for (const bone of JONATHAN_HUMANOID_SKELETON_TEMPLATE.bones) {
      if (bone.parent !== null) {
        expect(names.has(bone.parent), `${bone.name} parent ${bone.parent}`).toBe(true);
      }
    }
    expect(names).toContain('CC_Base_JawRoot');
    expect(names).toContain('CC_Base_L_Eye');
    expect(names).toContain('CC_Base_R_Eye');
  });

  it('computes deterministic rest bounds from local translations', () => {
    expect(computeHumanoidSkeletonTemplateRestBounds(JONATHAN_HUMANOID_SKELETON_TEMPLATE)).toMatchInlineSnapshot(`
      [
        -13.813711356138814,
        -1.7898722663521767,
        0,
        13.815083728521127,
        135.29448437690735,
        114.71438616554951,
      ]
    `);
  });

  it('can seed validation skeleton inputs from template data', () => {
    const validationSkeleton = createValidationSkeletonFromHumanoidTemplate();

    expect(validationSkeleton.bones).toHaveLength(101);
    expect(validationSkeleton.bones[0]).toEqual({ name: 'CC_Base_BoneRoot' });
    expect(validationSkeleton.bones).toContainEqual({ name: 'CC_Base_JawRoot' });
    expect(validationSkeleton.bones).toContainEqual({ name: 'CC_Base_L_Eye' });
    expect(validationSkeleton.bones).toContainEqual({ name: 'CC_Base_R_Eye' });
  });

  it('extracts a reusable template from a Three.js bone hierarchy', () => {
    const root = new THREE.Object3D();
    const hip = new THREE.Bone();
    hip.name = 'Hip';
    hip.position.set(0, 1, 0);
    const head = new THREE.Bone();
    head.name = 'Head';
    head.position.set(0, 2, 0);

    root.add(hip);
    hip.add(head);

    expect(extractHumanoidSkeletonTemplateFromModel(root, {
      id: 'test-template',
      sourceCharacterId: 'test-character',
      sourceAsset: 'test.glb',
      sourceSkinName: 'Armature',
    })).toEqual({
      id: 'test-template',
      sourceCharacterId: 'test-character',
      sourceAsset: 'test.glb',
      sourceSkinName: 'Armature',
      bones: [
        { name: 'Hip', parent: null, translation: [0, 1, 0] },
        { name: 'Head', parent: 'Hip', translation: [0, 2, 0] },
      ],
    });
  });
});
