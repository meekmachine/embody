import * as THREE from 'three';

import jonathanCcBaseTemplate from './data/jonathan-cc-base.json';

export type HumanoidSkeletonTemplateVec3 = readonly [number, number, number];
export type HumanoidSkeletonTemplateBounds = readonly [number, number, number, number, number, number];

export interface HumanoidSkeletonTemplateBone {
  readonly name: string;
  readonly parent: string | null;
  readonly translation: HumanoidSkeletonTemplateVec3;
}

export interface HumanoidSkeletonTemplate {
  readonly id: string;
  readonly sourceCharacterId: string;
  readonly sourceAsset: string;
  readonly sourceSkinName: string;
  readonly bones: readonly HumanoidSkeletonTemplateBone[];
}

export interface ExtractHumanoidSkeletonTemplateOptions {
  readonly id: string;
  readonly sourceCharacterId: string;
  readonly sourceAsset?: string;
  readonly sourceSkinName?: string;
}

export const HUMANOID_SKELETON_TEMPLATES = [
  jonathanCcBaseTemplate as unknown as HumanoidSkeletonTemplate,
] as const;

export const JONATHAN_HUMANOID_SKELETON_TEMPLATE = HUMANOID_SKELETON_TEMPLATES[0];

export function getHumanoidSkeletonTemplate(templateId: string): HumanoidSkeletonTemplate | null {
  return HUMANOID_SKELETON_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

export function getHumanoidSkeletonTemplateBoneNames(
  template: HumanoidSkeletonTemplate = JONATHAN_HUMANOID_SKELETON_TEMPLATE,
): string[] {
  return template.bones.map((bone) => bone.name);
}

export function createValidationSkeletonFromHumanoidTemplate(
  template: HumanoidSkeletonTemplate = JONATHAN_HUMANOID_SKELETON_TEMPLATE,
): { bones: Array<{ name: string }> } {
  return {
    bones: template.bones.map((bone) => ({ name: bone.name })),
  };
}

export function computeHumanoidSkeletonTemplateRestBounds(
  template: HumanoidSkeletonTemplate,
): HumanoidSkeletonTemplateBounds {
  const worldPositions = new Map<string, HumanoidSkeletonTemplateVec3>();
  const unresolved = new Set(template.bones.map((bone) => bone.name));

  while (unresolved.size > 0) {
    let resolvedThisPass = 0;

    for (const bone of template.bones) {
      if (!unresolved.has(bone.name)) continue;

      if (bone.parent === null) {
        worldPositions.set(bone.name, bone.translation);
        unresolved.delete(bone.name);
        resolvedThisPass += 1;
        continue;
      }

      const parentPosition = worldPositions.get(bone.parent);
      if (!parentPosition) continue;

      worldPositions.set(bone.name, addVec3(parentPosition, bone.translation));
      unresolved.delete(bone.name);
      resolvedThisPass += 1;
    }

    if (resolvedThisPass === 0) {
      throw new Error(`Unable to resolve humanoid skeleton template parent links for: ${Array.from(unresolved).join(', ')}`);
    }
  }

  const bounds: [number, number, number, number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];

  for (const position of worldPositions.values()) {
    bounds[0] = Math.min(bounds[0], position[0]);
    bounds[1] = Math.min(bounds[1], position[1]);
    bounds[2] = Math.min(bounds[2], position[2]);
    bounds[3] = Math.max(bounds[3], position[0]);
    bounds[4] = Math.max(bounds[4], position[1]);
    bounds[5] = Math.max(bounds[5], position[2]);
  }

  return bounds;
}

export function extractHumanoidSkeletonTemplateFromModel(
  root: THREE.Object3D,
  options: ExtractHumanoidSkeletonTemplateOptions,
): HumanoidSkeletonTemplate {
  assertNonEmptyString(options.id, 'id');
  assertNonEmptyString(options.sourceCharacterId, 'sourceCharacterId');

  const bones: HumanoidSkeletonTemplateBone[] = [];

  root.traverse((object) => {
    if (!isBoneObject(object)) return;
    if (!object.name) {
      throw new Error('Cannot extract humanoid skeleton template from an unnamed bone');
    }

    const parent = isBoneObject(object.parent) ? object.parent.name || null : null;
    bones.push({
      name: object.name,
      parent,
      translation: [object.position.x, object.position.y, object.position.z],
    });
  });

  if (bones.length === 0) {
    throw new Error('Cannot extract humanoid skeleton template from a model with no bones');
  }

  return {
    id: options.id,
    sourceCharacterId: options.sourceCharacterId,
    sourceAsset: options.sourceAsset ?? '',
    sourceSkinName: options.sourceSkinName ?? '',
    bones,
  };
}

function isBoneObject(object: THREE.Object3D | null | undefined): object is THREE.Bone {
  return object instanceof THREE.Bone || object?.type === 'Bone';
}

function assertNonEmptyString(value: string, fieldName: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

function addVec3(
  a: HumanoidSkeletonTemplateVec3,
  b: HumanoidSkeletonTemplateVec3,
): HumanoidSkeletonTemplateVec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
