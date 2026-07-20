/**
 * Embody - 3D Character Animation Engine
 *
 * A lightweight, framework-agnostic library for animating 3D character models
 * using Action Units (AUs), visemes, and bone transformations.
 *
 * @example
 * ```typescript
 * import { Embody, collectMorphMeshes, CC4_PRESET } from '@lovelace_lol/embody';
 * import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
 *
 * const loom = new Embody({ presetType: 'cc4' });
 *
 * const loader = new GLTFLoader();
 * loader.load('/character.glb', (gltf) => {
 *   const meshes = collectMorphMeshes(gltf.scene);
 *   loom.onReady({ meshes, model: gltf.scene });
 *
 *   // Control the face
 *   loom.setAU(12, 0.8);              // Smile
 *   loom.transitionAU(12, 0.8, 200);  // Animate over 200ms
 *   loom.setViseme(3, 0.7);           // Lip-sync
 * });
 *
 * // In animation loop
 * loom.update(deltaTime);
 * ```
 */

// ============================================================================
// IMPLEMENTATIONS (Three.js)
// ============================================================================

export {
  Embody,
  collectMorphMeshes,
} from './engines/three/Embody';
export {
  ThreeAnimationRuntime,
  ThreeAnimationSystem,
  AnimationController,
  BakedAnimationController,
} from './engines/three/ThreeAnimationRuntime';
export type {
  ThreeAnimationSystemHost,
  ThreeAnimationSystemOptions,
  AnimationControllerHost,
  BakedAnimationHost,
} from './engines/three/ThreeAnimationRuntime';
export { ThreeModelInspector } from './engines/three/ThreeModelInspector';
export type {
  ThreeAnimationClipDescriptor,
  ThreeAnimationTrackDescriptor,
  ThreeModelInspection,
  ThreeModelInspectionOptions,
} from './engines/three/ThreeModelInspector';
export { THREE_BLENDING_MODES, ThreeFrameApplier } from './engines/three/ThreeFrameApplier';
export { ThreeClipAdapter } from './engines/three/ThreeClipAdapter';
export type {
  ThreeFrameApplierBindings,
  ThreeMaterialConfig,
  ThreeMorphTargetBinding,
  ThreeResolvedMaterialConfig,
} from './engines/three/ThreeFrameApplier';
export type {
  ThreeClipAdapterBindings,
  ThreeClipMeshBinding,
  ThreeClipMorphTargetBinding,
} from './engines/three/ThreeClipAdapter';
export {
  TsClipCompiler,
  numericArrayToNumbers,
} from './core/TsClipCompiler';
export { TsRuntimeCore } from './core/TsRuntimeCore';
export {
  AU_MORPH_BINDING_STRIDE,
  VISEME_MORPH_BINDING_STRIDE,
  WasmRuntimeCore,
  compileMorphBindings,
  unpackMorphFrameDelta,
} from './core/WasmRuntimeCore';
export {
  EMBODY_CORE_ABI_VERSION,
  HAIR_CONFIG_FIELDS,
  HAIR_CONFIG_STRIDE,
  HAIR_HEAD_STATE_FIELDS,
  HAIR_HEAD_STATE_STRIDE,
  HAIR_MORPH_OUTPUT_FIELDS,
  HAIR_MORPH_OUTPUT_STRIDE,
  HAIR_STATE_FIELDS,
  HAIR_STATE_STRIDE,
  MESH_PROPORTIONS_FIELDS,
  MESH_PROPORTIONS_STRIDE,
  PACKED_MORPH_FRAME_DELTA_FIELDS,
  PACKED_MORPH_FRAME_DELTA_STRIDE,
  TEMPLATE_SKELETON_FIT_SOLUTION_FIELDS,
  TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE,
  TEMPLATE_SKELETON_FIT_TRANSFORM_FIELDS,
  TEMPLATE_SKELETON_FIT_TRANSFORM_STRIDE,
  getEmbodyCore,
  initEmbodyCore,
  resetEmbodyCoreForTests,
} from './wasm';
export type {
  TsClipCompilerInput,
  TsClipCompilerKeyframe,
  TsClipCompilerTrackInput,
  TsClipCurveTarget,
  TsClipCurvesInput,
} from './core/TsClipCompiler';
export type { TsRuntimeCoreOptions } from './core/TsRuntimeCore';
export type {
  MorphBindingSide,
  WasmRuntimeCoreOptions,
} from './core/WasmRuntimeCore';
export type {
  EmbodyCoreWasmModule,
  WasmHairPhysicsSolver,
  WasmHairPhysicsSolverConstructor,
} from './wasmTypes';
export type {
  HairConfigField,
  HairHeadStateField,
  HairMorphOutputField,
  HairStateField,
  PackedHairMorphOutput,
  PackedHairPhysicsState,
  PackedMorphFrameDelta,
  PackedMorphFrameDeltaField,
  PackedTemplateSkeletonFitTransform,
  TemplateSkeletonFitTransformField,
} from './core/contracts';

// ============================================================================
// INTERFACES (for implementing custom engines)
// ============================================================================

export type {
  EmbodyRuntime,
  ReadyPayload,
  EmbodyConfig,
} from './interfaces/EmbodyRuntime';

export type { Animation, MixerLoopMode } from './interfaces/Animation';

export type {
  HairPhysics as HairPhysicsInterface,
  HairPhysicsConfig,
  HairStrand,
  HairState,
  HeadState,
  HairMorphOutput,
} from './interfaces/HairPhysics';

export type {
  Hair,
  HairPhysicsRuntimeConfig,
  HairPhysicsRuntimeConfigUpdate,
  HairPhysicsDirectionConfig,
  HairMorphTargetsConfig,
  HairObjectRef,
  HairObjectState,
} from './interfaces/Hair';

// ============================================================================
// CORE TYPES
// ============================================================================

export type {
  TransitionHandle,
  AUSelector,
  BoneKey,
  BoneBinding,
  AUInfo,
  RotationAxis,
  CompositeRotation,
  CompositeRotationState,
  RotationsState,
  // Mixer animation types
  AnimationSource,
  AnimationBlendMode,
  AnimationEasing,
  AnimationPlayOptions,
  AnimationClipInfo,
  AnimationState,
  AnimationActionHandle,
  // Dynamic clip types
  CurvePoint,
  CurvesMap,
  SnippetChannelTarget,
  SnippetChannel,
  TypedSnippet,
  ClipOptions,
  ClipEvent,
  ClipEventListener,
  ClipHandle,
  Snippet,
  MorphTargetAttributeData,
  MorphTargetDelta,
  AddMorphTargetOptions,
} from './core/types';

export type {
  BoneDescriptor,
  BoneFrameDelta,
  BoneId,
  BoneTransformTrackTarget,
  ChannelId,
  ClipChannelIR,
  ClipChannelKind,
  ClipIR,
  ClipInterpolation,
  ClipTrackIR,
  ClipTrackTarget,
  ClipTrackTargetKind,
  ClipTrackTransformProperty,
  ClipTrackValueType,
  FrameDelta,
  FrameValueMode,
  HostAnimationHandle,
  HostAnimationPlayOptions,
  HostAnimationSystem,
  HostFrameApplier,
  HostModelInspector,
  HostTargetId,
  MeshDescriptor,
  MeshFrameDelta,
  MeshId,
  MeshVisibilityTrackTarget,
  ModelDescriptor,
  MorphTargetDescriptor,
  MorphTargetFrameDelta,
  MorphTargetId,
  MorphTargetTrackTarget,
  NumericArray,
  PackedMeshProportions,
  PackedTemplateSkeletonFitSolution,
  Quat,
  MeshProportionsField,
  TemplateSkeletonFitSolutionField,
  TemplateSkeletonFitManualAdjustment,
  TemplateSkeletonFitMetadata,
  TemplateSkeletonFitMetrics,
  TemplateSkeletonFitStatus,
  TemplateSkeletonFitTransform,
  TemplateSkeletonFitValidationResult,
  TemplateSkeletonFitVerticalAnchor,
  TemplateSkeletonFitVerticalAxis,
  TrackId,
  Transform,
  TransformSpace,
  Vec3,
} from './core/contracts';

export {
  TEMPLATE_SKELETON_FIT_METADATA_KIND,
  TEMPLATE_SKELETON_FIT_METADATA_VERSION,
  TEMPLATE_SKELETON_FIT_STATUSES,
  TEMPLATE_SKELETON_FIT_VERTICAL_ANCHORS,
  TEMPLATE_SKELETON_FIT_VERTICAL_AXES,
  composeTemplateSkeletonFitTransform,
  isTemplateSkeletonFitStatus,
  validateTemplateSkeletonFitMetadata,
} from './core/contracts';

// ============================================================================
// MAPPINGS
// ============================================================================

export type {
  Profile,
  MorphTargetsBySide,
  MorphTargetRef,
  HairPhysicsProfileConfig,
  HairMorphTargetMapping,
  HairMorphTargetValueMapping,
  HairMorphAxis,
  VisemeSlot,
  VisemeSlotFeatures,
  VisemeBinding,
  VisemeBindingTarget,
  MappingEditorSection,
  MappingEditorModel,
  MorphCandidate,
  MorphCandidateMatch,
  MorphCandidateReason,
  MorphCategory,
  MeshCategory,
  BlendingMode,
  MeshMaterialSettings,
  MeshInfo,
} from './mappings/types';

export { BLENDING_MODES } from './mappings/types';

export {
  buildMappingEditorModel,
  compileVisemeKeys,
  getMeshNamesForAUProfile,
  getMeshNamesForVisemeProfile,
  getProfileVisemeSlots,
  getVisemeBindingTargets,
  getVisemeJawAmounts,
  getVisemeSlotIndex,
  mapProviderVisemeToSlot,
  resolveVisemeMeshCategory,
} from './mappings/visemeSystem';

export type {
  ProviderVisemeEvent,
  ProviderVisemeMatch,
  ResolvedVisemeBindingTarget,
} from './mappings/visemeSystem';

export {
  applyAUBoneBindingUpdate,
  applyBilateralAxisBindingUpdate,
  applyBoneAxisBindingUpdate,
  buildBoneAuOptions,
  classifyAuAsJointControl,
  createBilateralBoneAxisAu,
  createBoneAxisAu,
  DEFAULT_AXIS_TO_CHANNEL,
  DEFAULT_BONE_MAX_DEGREES,
  ensureBilateralBoneNodeKeys,
  ensureBoneNodeKey,
  findNodeKeyForBone,
  formatAxisDirectionLabel,
  formatAxisLabel,
  getAUBoneBindingState,
  getAxisFromChannel,
  getBilateralAxisBindingState,
  getBoneAxisBindingState,
  inferChiralBoneNamePair,
  inferEyeControlFamily,
  inferEyeControlScope,
  isJointControlAuInfo,
  isMaxDegreesOnlyAxisBindingUpdate,
  JOINT_CONTROL_SECTION,
  resolveBoneAxisChannel,
  resolveBoneNameForNodeKey,
  resolveContinuumDisplayLabel,
  stripConfiguredBoneAffixes,
} from './authoring/boneAuthoring';

export type {
  AUBoneBindingState,
  BilateralAxisBindingState,
  BilateralAxisDirectionScaleState,
  BilateralAxisScopeBindingState,
  BilateralBoneAxisScope,
  BoneAxisBindingState,
  BoneAxisBindingUpdate,
  BoneAxisDirection,
  BoneAxisDirectionScale,
  BoneAxisKey,
  BoneControlFamily,
  BoneControlScope,
  ChiralBoneNamePair,
  CreatedBoneAxisAu,
  RotationChannel,
} from './authoring/boneAuthoring';

// ============================================================================
// PROFILES
// ============================================================================

export type {
  ProfileOverrides,
  ProfilePresetId,
  ProfileRuntimeConfig,
  ResolvedProfileRuntimeConfig,
  PresetBackedProfileRuntimeConfig,
  CustomProfileRuntimeConfig,
  CharacterProfile,
  ProfileRegistry,
  // Deprecated compatibility types
  CharacterConfig,
  CharacterRegistry,
} from './profiles/types';

export {
  extendProfileConfigWithPreset,
  extractLegacyCharacterProfileOverrides,
  getProfilePresetId,
  mergeProfileRegionsByName,
  resolveProfileFromPreset,
  // Deprecated compatibility exports
  applyCharacterProfileToPreset,
  extendCharacterConfigWithPreset,
  extractProfileOverrides,
  mergeRegionsByName as mergeCharacterRegionsByName,
} from './profiles/resolveProfileConfig';

// ============================================================================
// REGIONS AND MARKERS
// ============================================================================

export type {
  LineStyle,
  LineCurve,
  NamedDirection,
  LineConfig,
  MarkerStyleOverrides,
  ExpandAnimation,
  ExpandedRegionState,
  FallbackConfig,
  MarkerGroup,
  AnnotationRegion,
  Region,
  MarkerStyle,
} from './regions/types';

export type {
  CameraRelativeGazeOffset,
  CameraRelativeGazeOptions,
} from './camera/cameraRelativeGaze';

export { computeCameraRelativeGazeOffset } from './camera/cameraRelativeGaze';

export type {
  AnnotationLaterality,
} from './camera/annotationCameraAngles';

export {
  detectAnnotationLaterality,
  getDefaultAnnotationLaterality,
  getModelLocalOrbitAngle,
  getRegionSemanticSide,
  getSemanticHorizontalSign,
  getSemanticHorizontalSignForSide,
  getWorldDirectionForCameraAngle,
  normalizeCameraAngle,
  passesMarkerCameraAngleGate,
  resolveRegionCameraAngle,
  resolveRegionVisibilityCameraAngle,
  toModelLocalDirection,
  toWorldDirection,
} from './camera/annotationCameraAngles';

// ========================================================================
// REGION MAPPING HELPERS
// ========================================================================

export {
  fuzzyNameMatch,
  resolveBoneName,
  resolveBoneNames,
  resolveFaceCenter,
} from './regions/regionMapping';

export type {
  BoneResolutionProfile,
  ResolvedFaceCenter,
} from './regions/regionMapping';

// ============================================================================
// PRESETS
// ============================================================================

export { CC4_PRESET } from './presets/cc4';
export { extendPresetWithProfile } from './mappings/extendPresetWithProfile';

// Individual CC4 preset components (for apps that need direct access)
export {
  AU_TO_MORPHS,
  BONE_AU_TO_BINDINGS,
  LIP_SYNC_CONTROL_TO_BINDINGS,
  CC4_PROFILE_BONE_BINDINGS,
  AU_MIX_DEFAULTS,
  CC4_BONES,
  CC4_BONE_NODES,
  CC4_BONE_PREFIX,
  CC4_SUFFIX_PATTERN,
  CC4_EYE_MESH_NODES,
  CC4_MESHES,
  VISEME_KEYS,
  CC4_VISEME_SYSTEM_ID,
  CC4_VISEME_SLOTS,
  CC4_MAPPING_SECTIONS,
  VISEME_JAW_AMOUNTS,
  MORPH_TO_MESH,
  AU_INFO,
  COMPOSITE_ROTATIONS,
  CONTINUUM_PAIRS_MAP,
  CONTINUUM_LABELS,
  isMixedAU,
  hasLeftRightMorphs,
} from './presets/cc4';

// Fish/skeletal preset
export { BETTA_FISH_PRESET, AU_MAPPING_CONFIG, FISH_AU_MAPPING_CONFIG } from './presets/bettaFish';

// Preset lookup and profile extension by type name
export {
  getPreset,
  getPresetWithProfile,
  resolvePreset,
  resolvePresetWithOverrides,
} from './presets';
export type { PresetType } from './presets';

// ============================================================================
// PHYSICS
// ============================================================================

export {
  HairPhysics,
  DEFAULT_HAIR_PHYSICS_CONFIG,
} from './physics/HairPhysics';
export {
  RustHairPhysics,
  createRustHairPhysics,
  packHairConfig,
  packHeadState,
  unpackHairConfig,
  unpackHairMorphOutput,
  unpackHairState,
} from './physics/RustHairPhysics';

export type { HairPhysicsState, HairMorphOutput as HairPhysicsMorphOutput } from './physics/HairPhysics';

// ============================================================================
// VALIDATION
// ============================================================================

export {
  validateMappings,
  validateMappingConfig,
  isPresetCompatible,
  suggestBestPreset,
} from './validation/validateMappings';

export type {
  ValidationResult,
  MappingConsistencyResult,
  MappingIssue,
  ValidateMappingOptions,
} from './validation/validateMappings';

export {
  generateMappingCorrections,
} from './validation/generateMappingCorrections';

export type {
  MappingCorrection,
  MappingCorrectionOptions,
  MappingCorrectionResult,
} from './validation/generateMappingCorrections';

// Model extraction and analysis
export {
  extractModelData,
  extractFromGLTF,
} from './validation/extractModelData';

export type {
  ModelData,
  BoneInfo,
  MorphInfo,
  ModelMeshInfo,
  AnimationInfo,
  TrackInfo,
} from './validation/extractModelData';

export {
  analyzeModel,
} from './validation/analyzeModel';

export type {
  ModelAnalysisReport,
  AnalyzeModelOptions,
  AnimationAnalysis,
} from './validation/analyzeModel';

export {
  computeHumanoidSkeletonTemplateRestBounds,
  createValidationSkeletonFromHumanoidTemplate,
  extractHumanoidSkeletonTemplateFromModel,
  getHumanoidSkeletonTemplate,
  getHumanoidSkeletonTemplateBoneNames,
  HUMANOID_SKELETON_TEMPLATES,
  JONATHAN_HUMANOID_SKELETON_TEMPLATE,
} from './skeletonTemplates/humanoidSkeletonTemplates';

export type {
  ExtractHumanoidSkeletonTemplateOptions,
  HumanoidSkeletonTemplate,
  HumanoidSkeletonTemplateBone,
  HumanoidSkeletonTemplateBounds,
  HumanoidSkeletonTemplateVec3,
} from './skeletonTemplates/humanoidSkeletonTemplates';

// Geometry helpers for face/annotation positioning
export {
  findFaceCenter,
  getModelForwardDirection,
  detectFacingDirection,
} from './validation/geometryHelpers';

export type {
  FaceCenterResult,
  FindFaceCenterOptions,
} from './validation/geometryHelpers';
