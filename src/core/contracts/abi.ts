import type { NumericArray } from './primitives';

export const EMBODY_CORE_ABI_VERSION = 1;

export const PACKED_MORPH_FRAME_DELTA_STRIDE = 4;
export const PACKED_MORPH_FRAME_DELTA_FIELDS = [
  'meshId',
  'morphTargetId',
  'value',
  'mode',
] as const;

export const PACKED_BONE_FRAME_DELTA_STRIDE = 9;
export const PACKED_BONE_FRAME_DELTA_FIELDS = [
  'boneId',
  'positionX',
  'positionY',
  'positionZ',
  'rotationX',
  'rotationY',
  'rotationZ',
  'rotationW',
  'flags',
] as const;

/** Packed bone FrameDelta flags: bit 0 = has position, bit 1 = has rotation. */
export const PACKED_BONE_FLAG_HAS_POSITION = 1;
export const PACKED_BONE_FLAG_HAS_ROTATION = 2;

export const HAIR_CONFIG_STRIDE = 11;
export const HAIR_STATE_STRIDE = 4;
export const HAIR_HEAD_STATE_STRIDE = 5;
export const HAIR_MORPH_OUTPUT_STRIDE = 6;
export const TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE = 4;
export const MESH_PROPORTIONS_STRIDE = 16;
export const TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE = 10;
export const ANNOTATION_CAMERA_FRAMING_STRIDE = 7;
export const CAMERA_FLIGHT_SAMPLE_STRIDE = 7;
export const MARKER_VISIBILITY_FACTORS_STRIDE = 3;

export const HAIR_CONFIG_FIELDS = [
  'mass',
  'stiffness',
  'damping',
  'gravity',
  'headInfluence',
  'windEnabled',
  'windStrength',
  'windDirectionX',
  'windDirectionZ',
  'windTurbulence',
  'windFrequency',
] as const;

export const HAIR_STATE_FIELDS = ['x', 'z', 'vx', 'vz'] as const;
export const HAIR_HEAD_STATE_FIELDS = ['yaw', 'pitch', 'roll', 'yawVelocity', 'pitchVelocity'] as const;
export const HAIR_MORPH_OUTPUT_FIELDS = [
  'L_Hair_Left',
  'L_Hair_Right',
  'L_Hair_Front',
  'R_Hair_Left',
  'R_Hair_Right',
  'R_Hair_Front',
] as const;
export const TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS = [
  'scale',
  'translationX',
  'translationY',
  'translationZ',
] as const;
export const MESH_PROPORTIONS_FIELDS = [
  'minX',
  'minY',
  'minZ',
  'maxX',
  'maxY',
  'maxZ',
  'centerX',
  'centerY',
  'centerZ',
  'spanX',
  'spanY',
  'spanZ',
  'verticalHeight',
  'crossAxisWideSpan',
  'crossAxisNarrowSpan',
  'humanoidLikelihood',
] as const;
export const TEMPLATE_SKELETON_FIT_SOLUTION_FIELDS = [
  'scale',
  'translationX',
  'translationY',
  'translationZ',
  'confidence',
  'meshHeight',
  'templateHeight',
  'meshCrossAxisWideSpan',
  'templateCrossAxisWideSpan',
  'status',
] as const;
export const ANNOTATION_CAMERA_FRAMING_FIELDS = [
  'positionX',
  'positionY',
  'positionZ',
  'targetX',
  'targetY',
  'targetZ',
  'distance',
] as const;
export const CAMERA_FLIGHT_SAMPLE_FIELDS = [
  'positionX',
  'positionY',
  'positionZ',
  'targetX',
  'targetY',
  'targetZ',
  'done',
] as const;
export const MARKER_VISIBILITY_FACTORS_FIELDS = [
  'itemOpacityFactor',
  'labelScaleFactor',
  'lineOpacityFactor',
] as const;

export type PackedMorphFrameDeltaField = (typeof PACKED_MORPH_FRAME_DELTA_FIELDS)[number];
export type HairConfigField = (typeof HAIR_CONFIG_FIELDS)[number];
export type HairStateField = (typeof HAIR_STATE_FIELDS)[number];
export type HairHeadStateField = (typeof HAIR_HEAD_STATE_FIELDS)[number];
export type HairMorphOutputField = (typeof HAIR_MORPH_OUTPUT_FIELDS)[number];
export type TemplateSkeletonFitTransformField = (typeof TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS)[number];
export type MeshProportionsField = (typeof MESH_PROPORTIONS_FIELDS)[number];
export type TemplateSkeletonFitSolutionField = (typeof TEMPLATE_SKELETON_FIT_SOLUTION_FIELDS)[number];

export interface PackedMorphFrameDelta {
  readonly abiVersion: typeof EMBODY_CORE_ABI_VERSION;
  readonly stride: typeof PACKED_MORPH_FRAME_DELTA_STRIDE;
  readonly fields: typeof PACKED_MORPH_FRAME_DELTA_FIELDS;
  readonly values: NumericArray;
}

export interface PackedHairPhysicsState {
  readonly stride: typeof HAIR_STATE_STRIDE;
  readonly fields: typeof HAIR_STATE_FIELDS;
  readonly values: NumericArray;
}

export interface PackedHairMorphOutput {
  readonly stride: typeof HAIR_MORPH_OUTPUT_STRIDE;
  readonly fields: typeof HAIR_MORPH_OUTPUT_FIELDS;
  readonly values: NumericArray;
}

export interface PackedTemplateSkeletonFitTransform {
  readonly stride: typeof TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE;
  readonly fields: typeof TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS;
  readonly values: NumericArray;
}

export interface PackedMeshProportions {
  readonly stride: typeof MESH_PROPORTIONS_STRIDE;
  readonly fields: typeof MESH_PROPORTIONS_FIELDS;
  readonly values: NumericArray;
}

export interface PackedTemplateSkeletonFitSolution {
  readonly stride: typeof TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE;
  readonly fields: typeof TEMPLATE_SKELETON_FIT_SOLUTION_FIELDS;
  readonly values: NumericArray;
}
