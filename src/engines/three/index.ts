/**
 * Three.js Engine Implementation
 */

export {
  Embody,
  collectMorphMeshes,
} from './Embody';
export {
  ThreeAnimationRuntime,
  ThreeAnimationSystem,
  AnimationController,
  BakedAnimationController,
} from './ThreeAnimationRuntime';
export type {
  ThreeAnimationSystemHost,
  ThreeAnimationSystemOptions,
  AnimationControllerHost,
  BakedAnimationHost,
} from './ThreeAnimationRuntime';
export { ThreeModelInspector } from './ThreeModelInspector';
export type {
  ThreeAnimationClipDescriptor,
  ThreeAnimationTrackDescriptor,
  ThreeModelInspection,
  ThreeModelInspectionOptions,
} from './ThreeModelInspector';
export { THREE_BLENDING_MODES, ThreeFrameApplier } from './ThreeFrameApplier';
export { RustEmbodyHost } from './RustEmbodyHost';
export type { RustEmbodyHostConfig } from './RustEmbodyHost';
export { ThreeClipAdapter } from './ThreeClipAdapter';
export type {
  ThreeFrameApplierBindings,
  ThreeMaterialConfig,
  ThreeMorphTargetBinding,
  ThreeResolvedMaterialConfig,
} from './ThreeFrameApplier';
export type {
  ThreeClipAdapterBindings,
  ThreeClipMeshBinding,
  ThreeClipMorphTargetBinding,
} from './ThreeClipAdapter';
export {
  createCharacterHost,
} from './characterHost';
export type {
  CharacterHost,
  CharacterHostCharacterOptions,
  CharacterHostExternalScene,
  CharacterHostOptions,
} from './characterHost';
export {
  CHARACTER_SCENE_TYPE_IDS,
  CHARACTER_SCENE_TYPES,
  createDefaultCharacterLighting,
  createDefaultCharacterScene,
  createShadowPlane,
  DEFAULT_CHARACTER_LIGHTING_PRESET_ID,
  DEFAULT_CHARACTER_LIGHTING_PRESET_IDS,
  DEFAULT_CHARACTER_LIGHTING_PRESETS,
  DEFAULT_CHARACTER_LIGHTING_SETTINGS,
  DEFAULT_CHARACTER_SCENE_TYPE_ID,
  normalizeDefaultCharacterLightingSettings,
} from './characterScene';
export type {
  CharacterSceneTypeDefinition,
  CharacterSceneTypeId,
  DefaultCharacterLightingController,
  DefaultCharacterLightingPresetId,
  DefaultCharacterLightingSettings,
  DefaultCharacterScene,
  DefaultCharacterSceneOptions,
} from './characterScene';
export {
  applyCharacterModelTransform,
  disposeCharacterModel,
  loadCharacterModel,
  parseCharacterModel,
} from './modelLoader';
export type {
  CharacterModelLoadOptions,
  CharacterModelLoadResult,
  CharacterModelTransform,
} from './modelLoader';
