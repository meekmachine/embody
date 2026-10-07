export { ThreeAnnotations, CameraController, Markers3D, MarkersHTML, Controls } from './ThreeAnnotations';
export type { ThreeAnnotationsConfig, CharacterValidationResult, ValidationCategory, ValidationItem } from './ThreeAnnotations';
export { ThreeAnnotationController } from './ThreeAnnotationController';
export type { ThreeAnnotationControls } from './ThreeAnnotationControls';
export type { MarkerStateSnapshot } from './ThreeAnnotationController';
export { ThreeAnnotationMarkers } from './ThreeAnnotationMarkers';
export { HtmlAnnotationMarkers } from './HtmlAnnotationMarkers';
export { OverlayAnnotationMarkers } from './OverlayAnnotationMarkers';
export { CameraDOMControls, RUNTIME_ANNOTATION_REGION_PREFIX, filterCameraViewRegions, isRuntimeAnnotationRegionName, buildRegionDisplayOptions } from './DOMControls';
export type { DOMControlRegion, DOMControlsConfig } from './DOMControls';
export { resolveMarkerAnchorRegion, shouldProjectMarkerAnchorToSurface, shouldUseFaceCenterForMarkerAnchor } from './annotationAnchorModel';
export type { MarkerAnchorProjectionMode, ResolvedMarkerAnchorRegion } from './annotationAnchorModel';
export { getRuntimeAnnotationSide, getRuntimeAUMorphAnchorPoint, getRuntimeAUMeshSideOffset } from './runtimeAnnotationSidePreview';
export { createMarkerVisibilityLifecycle, createMarkerLifecycleRevealOptions, DEFAULT_MARKER_AUTO_HIDE_MS } from './markerVisibilityLifecycle';
export type { MarkerLifecycleRevealOptions, MarkerLifecycleRevealSource } from './markerVisibilityLifecycle';
export { createRuntimeAnnotationPreviewLifecycle, DEFAULT_PREVIEW_AUTO_CLEAR_MS } from './runtimeAnnotationPreview';
export type { RuntimeAnnotationPreviewLifecycleOptions } from './runtimeAnnotationPreview';
export { inferRuntimeAnnotationPreviewSide, pickContinuumAnnotationAuId } from './runtimeAnnotationPreviewSide';
export { boneResolutionProfile } from './boneResolutionProfile';
export {
  resolveAnnotationCharacterConfig, RustAnnotationCameraCore, createRustAnnotationCameraCore,
  getDefaultAnnotationLaterality, getSemanticHorizontalSignForSide, getSemanticHorizontalSign,
  resolveRegionCameraAngle, resolveRegionVisibilityCameraAngle, toWorldDirection,
  getWorldDirectionForCameraAngle, getModelLocalOrbitAngle, passesMarkerCameraAngleGate,
  resolveFaceCenter, detectAnnotationLaterality,
} from './adapter';
export type {
  AnnotationCharacterConfig, AnnotationAnchorPoint, AnnotationMarkerAnchor,
  AnnotationMarkerAnchorType, AnnotationFocusTarget, AnnotationAnchoredRegion,
  RuntimeAnnotationMetadata, RuntimeAnnotationOptions, RuntimeAnnotationRegionSummary,
  RuntimeAnnotationSide, RuntimeAnnotationTargetType, CameraState, FocusPosition,
  ThreeAnnotationControllerConfig, RegionChangeCallback, CharacterChangeCallback,
  AnnotationRegion, AnnotationRegistry, AnnotationRegionChangeCallback,
  AnnotationCharacterChangeCallback, LineStyle, LineCurve, NamedDirection, LineConfig,
  MarkerStyleOverrides, ExpandAnimation, ExpandedRegionState, FallbackConfig,
  MarkerGroup, Region, MarkerStyle, BoneResolutionProfile, AnnotationLaterality,
} from './types';
