// Authoring data exchanged with the Rust profile APIs; renderer objects stay in the adapter.
import type { Region, MarkerStyle, MarkerGroup, LineConfig, MarkerStyleOverrides } from './annotations/types';
export interface AuthoringVector3 { x: number; y: number; z: number; }
export interface AuthoringQuaternion extends AuthoringVector3 { w: number; }

export type PresetType = 'cc4' | 'fish' | string;
export type BoneAxisKey = 'pitch' | 'yaw' | 'roll';
export type BoneAxisDirection = 'negative' | 'positive';
export type BoneAxisDirectionScale = -1 | 1;
export type RotationChannel = 'rx' | 'ry' | 'rz';
export type BilateralBoneAxisScope = 'shared' | 'left' | 'right';
export type BoneControlFamily = 'Horizontal Gaze' | 'Vertical Gaze';
export type BoneControlScope = 'Both Eyes' | 'Left Eye Only' | 'Right Eye Only';
export type HumanoidSkeletonTemplateVec3 = readonly [number, number, number];
export type HumanoidSkeletonTemplateBounds = readonly [number, number, number, number, number, number];
export type MorphTargetRef = string | number;
export type MeshCategory = 'body' | 'eye' | 'eyeOcclusion' | 'tearLine' | 'teeth' | 'tongue' | 'hair' | 'eyebrow' | 'cornea' | 'eyelash';
export type BlendingMode = 'Normal' | 'Additive' | 'Subtractive' | 'Multiply' | 'None';

export interface MorphTargetsBySide {
  left: MorphTargetRef[];
  right: MorphTargetRef[];
  center: MorphTargetRef[];
}

export interface BoneBinding {
  node: string;
  channel: 'rx' | 'ry' | 'rz' | 'tx' | 'ty' | 'tz';
  scale: BoneAxisDirectionScale;
  maxDegrees?: number;
  maxUnits?: number;
  side?: 'left' | 'right';
}

export interface AUInfo {
  id: string;
  name: string;
  muscularBasis?: string;
  links?: string[];
  faceArea?: 'Upper' | 'Lower' | 'Body';
  facePart?: string;
}

export interface RotationAxis {
  aus: number[];
  axis: RotationChannel;
  negative?: number | number[];
  positive?: number | number[];
}

export interface CompositeRotation {
  node: string;
  pitch: RotationAxis | null;
  yaw: RotationAxis | null;
  roll: RotationAxis | null;
}

export interface VisemeSlotFeatures {
  jawOpen?: number;
  lipClosed?: number;
  lipRound?: number;
  lipSpread?: number;
  tongueTip?: number;
  fricative?: number;
  nasal?: number;
}

export interface VisemeSlot {
  id: string;
  label: string;
  order?: number;
  providerIds?: Record<string, Array<string | number>>;
  phonemes?: string[];
  matchers?: string[];
  features?: VisemeSlotFeatures;
  defaultJawAmount?: number;
}

export type VisemeTongueTarget = Record<string, number>;

export interface VisemeBindingTarget {
  morph: MorphTargetRef;
  weight?: number;
}

export interface VisemeBinding {
  targets?: VisemeBindingTarget[];
  morph?: MorphTargetRef;
  jawAmount?: number;
  note?: string;
  sharedWith?: string[];
}

export interface ResolvedVisemeSlot extends Omit<VisemeSlot, 'label'> {
  label?: string;
  [extension: string]: unknown;
}
/** Model-independent authored resolution. Array indices equal Embody runtime slot indices. */
export interface ResolvedVisemeProfile {
  routingMode: 'explicit' | 'legacy';
  /** Stock canonical sound index to runtime slot index, including reordered stock profiles. */
  canonicalSlotIndices?: number[];
  visemeSlots: ResolvedVisemeSlot[];
  visemeBindingTargets: Array<Array<Required<VisemeBindingTarget>>>;
  visemeJawAmounts: number[];
  visemeTongueTargets: VisemeTongueTarget[];
  visemeMeshNames: string[];
  visemeMeshCategory: string;
}

export interface MappingEditorSection {
  id: string;
  label: string;
  kind: 'au' | 'viseme' | 'lipSync' | 'hair' | 'unmapped' | 'custom';
  order: number;
  meshCategory?: string;
  facePart?: string;
}

export interface MeshMaterialSettings {
  renderOrder?: number;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  depthTest?: boolean;
  blending?: BlendingMode;
}

export interface MeshInfo {
  name?: string;
  visible?: boolean;
  category: MeshCategory;
  morphCount: number;
  material?: MeshMaterialSettings;
}

export type HairMorphAxis = 'yaw' | 'pitch' | 'roll';
export interface HairMorphTargetMapping { key: string; axis: HairMorphAxis; }
export interface HairMorphTargetValueMapping { value: number; axis: HairMorphAxis; }
export interface HairPhysicsProfileConfig {
  enabled?: boolean;
  stiffness?: number;
  damping?: number;
  inertia?: number;
  gravity?: number;
  responseScale?: number;
  idleSwayAmount?: number;
  idleSwaySpeed?: number;
  windStrength?: number;
  windDirectionX?: number;
  windDirectionZ?: number;
  windTurbulence?: number;
  windFrequency?: number;
  idleClipDuration?: number;
  impulseClipDuration?: number;
  direction?: { yawSign?: 1 | -1; pitchSign?: 1 | -1 };
  morphTargets?: {
    swayLeft?: HairMorphTargetMapping;
    swayRight?: HairMorphTargetMapping;
    swayFront?: HairMorphTargetMapping;
    fluffRight?: HairMorphTargetMapping;
    fluffBottom?: HairMorphTargetMapping;
    headUp?: Record<string, HairMorphTargetValueMapping>;
    headDown?: Record<string, HairMorphTargetValueMapping>;
  };
}

export type VRMHumanoidRole =
  | 'hips' | 'spine' | 'chest' | 'upperChest' | 'neck' | 'head' | 'leftEye' | 'rightEye' | 'jaw'
  | 'leftShoulder' | 'leftUpperArm' | 'leftLowerArm' | 'leftHand'
  | 'rightShoulder' | 'rightUpperArm' | 'rightLowerArm' | 'rightHand'
  | 'leftUpperLeg' | 'leftLowerLeg' | 'leftFoot' | 'leftToes'
  | 'rightUpperLeg' | 'rightLowerLeg' | 'rightFoot' | 'rightToes'
  | 'leftThumbMetacarpal' | 'leftThumbProximal' | 'leftThumbDistal'
  | 'rightThumbMetacarpal' | 'rightThumbProximal' | 'rightThumbDistal'
  | 'leftIndexProximal' | 'leftIndexIntermediate' | 'leftIndexDistal'
  | 'rightIndexProximal' | 'rightIndexIntermediate' | 'rightIndexDistal'
  | 'leftMiddleProximal' | 'leftMiddleIntermediate' | 'leftMiddleDistal'
  | 'rightMiddleProximal' | 'rightMiddleIntermediate' | 'rightMiddleDistal'
  | 'leftRingProximal' | 'leftRingIntermediate' | 'leftRingDistal'
  | 'rightRingProximal' | 'rightRingIntermediate' | 'rightRingDistal'
  | 'leftLittleProximal' | 'leftLittleIntermediate' | 'leftLittleDistal'
  | 'rightLittleProximal' | 'rightLittleIntermediate' | 'rightLittleDistal';

/** A standard bone role; motion axes/ranges belong to the authored rig profile. */
export interface HumanoidBoneDefinition {
  role: VRMHumanoidRole;
  label: string;
  section: 'Torso' | 'Head' | 'Arms' | 'Hands' | 'Legs' | 'Feet';
  parent: VRMHumanoidRole | null;
  required: boolean;
  /** This optional parent must be mapped when the child is mapped. */
  requiresParent: boolean;
}

export interface HumanoidSpecification {
  standard: 'VRMC_vrm-1.0';
  bones: HumanoidBoneDefinition[];
}

export interface HumanoidRoleBinding {
  nodeKey: string;
  /** Literal model bone selected by the role editor, before preset prefix lookup. */
  exactBoneName?: string;
  source?: string;
  confidence?: number;
}

export interface HumanoidCharacterization {
  schemaVersion: 1;
  standard: 'VRMC_vrm-1.0';
  status: 'verified-vrm' | 'characterized' | 'incomplete';
  /** Explicitly edited role catalogs are authoritative across preset upgrades. */
  authored?: boolean;
  roles: Partial<Record<VRMHumanoidRole, HumanoidRoleBinding>>;
}

export interface HumanoidCharacterizationResolution {
  schemaVersion: number | null;
  standard: string | null;
  status: string | null;
  roles: Record<string, { nodeKey: string; boneName: string; source: string | null; confidence: number | null }>;
  missingRequiredRoles: string[];
  errors: string[];
  warnings: string[];
  valid: boolean;
}

/** Semantic body actions reuse the AU bone/morph evaluator. VRM names identify targets. */
export interface BodyControlDefinition {
  label: string;
  section: string;
  auId: number;
  negativeAuId?: number | null;
  bilateral: boolean;
  roles: VRMHumanoidRole[];
  order?: number;
}

export interface BodyControlDescriptor {
  id: string;
  label: string;
  section: string;
  auId: number;
  negativeAuId: number | null;
  auIds: number[];
  bilateral: boolean;
  roles: VRMHumanoidRole[];
  order: number;
  boneBindings: Array<BoneBinding & { auId: number; boneName: string }>;
  morphBindings: MorphTargetsBySide;
  meshNames: string[];
  hasBones: boolean;
  hasMorphs: boolean;
  isMixed: boolean;
  available: boolean;
  diagnostics: string[];
}

/** Pose values are normalized authored action amounts, never world Euler angles. */
export interface SemanticPoseChannel {
  intensity: number;
  /** -1 = character's left, 0 = both, +1 = character's right. */
  balance?: number;
  /** Morph contribution only; bone activation remains intensity. Defaults to profile. */
  morphStrength?: number;
}
export interface SemanticPose {
  version: 1;
  controls: Array<{ controlId: string; positive?: SemanticPoseChannel; negative?: SemanticPoseChannel }>;
}
export interface SemanticPoseDirection {
  auId: number; label: string; available: boolean; availableSides?: Array<'left' | 'right' | 'center'>; hasBones: boolean; hasMorphs: boolean; morphStrength: number;
}
export interface SemanticPoseControl {
  id: string; label: string; section: string; roles: string[]; bilateral: boolean;
  boneNames: string[]; morphNames: string[];
  positive: SemanticPoseDirection; negative?: SemanticPoseDirection;
}
export interface SemanticAnimation {
  version: 1;
  durationSeconds: number;
  tracks: Array<{ controlId: string; direction: 'positive' | 'negative'; balance?: number; morphStrength?: number;
    keyframes: Array<{ time: number; intensity: number }> }>;
}
export interface SemanticAnimationOptions extends Record<string, unknown> {
  faceCurves?: Record<string, Array<{ time: number; intensity: number; inherit?: boolean }>>;
}

export interface Profile {
  name?: string;
  animalType?: string;
  emoji?: string;
  auToMorphs: Record<number, MorphTargetsBySide>;
  auToBones: Record<number, BoneBinding[]>;
  boneNodes: Record<string, string>;
  bonePrefix?: string;
  boneSuffix?: string;
  morphPrefix?: string;
  morphSuffix?: string;
  suffixPattern?: string;
  leftMorphSuffixes?: string[];
  rightMorphSuffixes?: string[];
  morphToMesh: Record<string, string[]>;
  auFacePartToMeshCategory?: Record<string, string>;
  mappingSections?: MappingEditorSection[];
  visemeKeys: MorphTargetRef[];
  visemeSystemId?: string;
  visemeSlots?: VisemeSlot[];
  visemeBindings?: Record<string, VisemeBinding>;
  visemeMeshCategory?: string;
  visemeJawAmounts?: number[];
  /** Per-viseme tongue AU targets in canonical slot order. */
  visemeTongueTargets?: VisemeTongueTarget[];
  auMixDefaults?: Record<number, number>;
  auInfo?: Record<string, AUInfo>;
  eyeMeshNodes?: { LEFT: string; RIGHT: string };
  compositeRotations?: CompositeRotation[];
  meshes?: Record<string, MeshInfo>;
  continuumPairs?: Record<number, {
    pairId: number;
    isNegative: boolean;
    axis: BoneAxisKey;
    node: string;
  }>;
  continuumLabels?: Record<string, string>;
  annotationRegions?: Region[];
  disabledRegions?: string[];
  hairPhysics?: HairPhysicsProfileConfig;
  humanoidCharacterization?: HumanoidCharacterization;
  /** Authored overrides may patch individual fields; null removes a preset control. */
  bodyControls?: Record<string, Partial<BodyControlDefinition> | null>;
}

export interface ProfileRuntimeConfig extends Partial<Profile> {
  profilePresetId?: PresetType;
  presetId?: PresetType;
  baseProfileId?: PresetType;
  auPresetType?: PresetType;
  profile?: Partial<Profile>;
  defaultRegion?: string;
  regions?: Region[];
  markerStyle?: MarkerStyle;
  playIntroOnLoad?: boolean;
  modelOffset?: { x?: number; y?: number; z?: number };
  modelRotation?: { x?: number; y?: number; z?: number };
  modelScale?: number;
  modelGroundClearance?: number;
  deletedBakedAnimationClips?: string[];
  markerGroups?: MarkerGroup[];
  lineDefaults?: LineConfig;
  markerDefaults?: Partial<MarkerStyleOverrides>;
}

export interface CharacterProfile extends ProfileRuntimeConfig {
  characterId?: string;
  characterName?: string;
  modelPath?: string;
}

export type CharacterConfig = CharacterProfile & {
  characterId: string;
  characterName: string;
  modelPath: string;
  regions: Region[];
};

export interface HairColorAppearance { name: string; baseColor: string; emissive: string; emissiveIntensity: number; }
export interface HairAppearanceState { hairColor: HairColorAppearance; eyebrowColor: HairColorAppearance; showOutline: boolean; outlineColor: string; outlineOpacity: number; }
export interface HairPhysicsRuntimeConfig { enabled: boolean; [key: string]: any; }
export type HairPhysicsRuntimeConfigUpdate = Partial<HairPhysicsRuntimeConfig>;
export interface TransitionHandle { promise: Promise<void>; pause(): void; resume(): void; cancel(): void; }

export interface BoneAxisBindingUpdate {
  channel?: RotationChannel;
  positiveAuId?: number | null;
  negativeAuId?: number | null;
  positiveMaxDegrees?: number | null;
  negativeMaxDegrees?: number | null;
  positiveScale?: BoneAxisDirectionScale | null;
  negativeScale?: BoneAxisDirectionScale | null;
  positiveLeftScale?: BoneAxisDirectionScale | null;
  positiveRightScale?: BoneAxisDirectionScale | null;
  negativeLeftScale?: BoneAxisDirectionScale | null;
  negativeRightScale?: BoneAxisDirectionScale | null;
}
export interface BoneAxisBindingState { axis: BoneAxisKey; channel: RotationChannel; nodeKey: string; positiveAuId: number | null; negativeAuId: number | null; positiveMaxDegrees: number | null; negativeMaxDegrees: number | null; positiveScale: BoneAxisDirectionScale | null; negativeScale: BoneAxisDirectionScale | null; }
export interface AUBoneBindingState { auId: number; boneName: string | null; nodeKey: string | null; axis: BoneAxisKey; direction: BoneAxisDirection; channel: RotationChannel | null; maxDegrees: number | null; oppositeAuId: number | null; oppositeMaxDegrees: number | null; hasBinding: boolean; hasMultipleBindings: boolean; }
export interface BilateralAxisDirectionScaleState { left: BoneAxisDirectionScale | null; right: BoneAxisDirectionScale | null; }
export interface BilateralAxisScopeBindingState { scope: BilateralBoneAxisScope; label: string; negativeAuId: number | null; positiveAuId: number | null; negativeMaxDegrees: number | null; positiveMaxDegrees: number | null; negativeScale: BilateralAxisDirectionScaleState; positiveScale: BilateralAxisDirectionScaleState; }
export interface BilateralAxisBindingState { axis: BoneAxisKey; familyLabel: string; leftBoneName: string; leftNodeKey: string; rightBoneName: string; rightNodeKey: string; selectedSide: 'left' | 'right'; shared: BilateralAxisScopeBindingState; left: BilateralAxisScopeBindingState; right: BilateralAxisScopeBindingState; }
export interface ChiralBoneNamePair { leftBoneName: string; rightBoneName: string; selectedSide: 'left' | 'right'; familyLabel: string; }
export interface CreatedBoneAxisAu { auId: number; profile: Profile; }

export interface BoneInfo { name: string; parent: string | null; children: string[]; worldPosition: { x: number; y: number; z: number }; depth: number; }
export interface TrackInfo { name: string; targetName: string; property: string; type: string; keyframeCount: number; valueRange?: { min: number[]; max: number[] }; }
export interface AnimationInfo { name: string; duration: number; tracks: TrackInfo[]; animatedBones: string[]; animatedMorphs: string[]; }
export interface ModelData { bones: BoneInfo[]; morphs: Array<{ name: string; meshName: string; index: number }>; meshes: Array<{ name: string; hasMorphTargets: boolean; morphCount: number }>; animations: AnimationInfo[]; boneNames: string[]; morphNames: string[]; meshNames: string[]; }
export interface MappingCorrection { type: 'bone' | 'morph' | 'viseme' | 'mesh'; source: string; target: string; confidence: number; reason: string; applied: boolean; auId?: number; key?: string; }
export interface ValidationResult { valid: boolean; score: number; missingMorphs: string[]; missingBones: string[]; foundMorphs: string[]; foundBones: string[]; unmappedMorphs: string[]; unmappedBones: string[]; missingMeshes: string[]; foundMeshes: string[]; unmappedMeshes: string[]; warnings: string[]; suggestedConfig?: Profile; corrections?: MappingCorrection[]; unresolved?: MappingCorrection[]; }
export interface ModelAnalysisReport { model: ModelData; validation?: ValidationResult; animations: { count: number; hasIdleCandidate: boolean; clips: unknown[] }; overallScore: number; summary: string; }

export interface HumanoidSkeletonTemplateBone { readonly name: string; readonly parent: string | null; readonly translation: HumanoidSkeletonTemplateVec3; }
export interface HumanoidSkeletonTemplate { readonly id: string; readonly sourceCharacterId: string; readonly sourceAsset: string; readonly sourceSkinName: string; readonly bones: readonly HumanoidSkeletonTemplateBone[]; }

