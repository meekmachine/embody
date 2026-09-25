import type * as THREE from 'three';

export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type LineCurve = 'straight' | 'bezier' | 'arc';
export type NamedDirection = 'radial' | 'camera' | 'up' | 'down' | 'left' | 'right' | 'forward' | 'backward';
export interface LineConfig { style?: LineStyle; curve?: LineCurve; arrowHead?: boolean; thickness?: number; length?: number; }
export interface MarkerStyleOverrides {
  markerColor?: number;
  markerRadius?: number;
  lineColor?: number;
  labelColor?: string;
  labelBackground?: string;
  labelFontSize?: number;
  opacity?: number;
  lineDirection?: NamedDirection | { x: number; y: number; z: number };
  line?: LineConfig;
}
export type ExpandAnimation = 'outward' | 'staggered';
export interface ExpandedRegionState { regionName: string; isExpanded: boolean; children: string[]; }
export interface FallbackConfig { fallbackMarker?: string; clickBehavior?: 'fit-all' | 'rotate'; }
export interface MarkerGroup { groupId: string; regions: string[]; fallback?: FallbackConfig; }
export interface Region {
  name: string;
  bones?: string[];
  meshes?: string[];
  objects?: string[];
  paddingFactor?: number;
  cameraAngle?: number;
  cameraOffset?: { x?: number; y?: number; z?: number };
  parent?: string;
  children?: string[];
  expandAnimation?: ExpandAnimation;
  style?: MarkerStyleOverrides;
  groupId?: string;
  isFallback?: boolean;
  customPosition?: { x: number; y: number; z: number };
}
export type MarkerStyle = 'html' | '3d';

export interface AnnotationAnchorPoint {
  x: number;
  y: number;
  z: number;
}

export type AnnotationMarkerAnchorType =
  | 'region'
  | 'point'
  | 'bone'
  | 'mesh'
  | 'object'
  | 'face-center';

/**
 * Explicit marker-anchor intent for annotation regions.
 *
 * Shared renderer-adapter contract for authored and runtime annotation regions.
 */
export interface AnnotationMarkerAnchor {
  type: AnnotationMarkerAnchorType;
  bones?: string[];
  meshes?: string[];
  objects?: string[];
  position?: AnnotationAnchorPoint;
  /**
   * Whether 3D markers should raycast from the resolved anchor toward the
   * visible model surface before drawing the marker sphere.
   */
  projectToSurface?: boolean;
}

export interface AnnotationFocusTarget {
  type: 'region' | 'point' | 'bone' | 'mesh' | 'object' | 'face-center';
  bones?: string[];
  meshes?: string[];
  objects?: string[];
  position?: AnnotationAnchorPoint;
  paddingFactor?: number;
  cameraAngle?: number;
}

export type RuntimeAnnotationTargetType = 'bone' | 'au';
export type RuntimeAnnotationSide = 'left' | 'right' | 'center';

export interface RuntimeAnnotationMetadata {
  targetType: RuntimeAnnotationTargetType;
  target: string;
  boneName?: string;
  meshName?: string;
  morphNames?: string[];
  side?: RuntimeAnnotationSide;
}

export interface RuntimeAnnotationOptions {
  label?: string;
  markerColor?: number;
  lineColor?: number;
  markerRadius?: number;
  labelColor?: string;
  labelBackground?: string;
  labelFontSize?: number;
  opacity?: number;
  paddingFactor?: number;
  cameraAngle?: number;
  projectToSurface?: boolean;
  maxTargets?: number;
  targetPreference?: 'bone' | 'mesh';
  targetSide?: RuntimeAnnotationSide;
  replaceExisting?: boolean;
}

export interface RuntimeAnnotationRegionSummary {
  name: string;
  label: string;
  targetType: RuntimeAnnotationTargetType;
  target: string;
  bones: string[];
  meshes?: string[];
  morphs?: string[];
  side?: RuntimeAnnotationSide;
}

export type AnnotationAnchoredRegion = Region & {
  label?: string;
  markerAnchor?: AnnotationMarkerAnchor;
  focusTarget?: AnnotationFocusTarget;
  runtimeAnnotation?: RuntimeAnnotationMetadata;
};

export interface BoneResolutionProfile { bonePrefix?: string; boneSuffix?: string; boneNodes?: Record<string, string>; suffixPattern?: string; }
export interface AnnotationLaterality { leftSideX: 1 | -1; confidence: number; evidence: string[]; }
/** Structural runtime input; host storage, authoring and agency fields are not owned here. */
export interface AnnotationCharacterConfig extends BoneResolutionProfile {
  characterId: string;
  characterName?: string;
  modelPath?: string;
  regions?: AnnotationAnchoredRegion[];
  annotationRegions?: AnnotationAnchoredRegion[];
  markerStyle?: MarkerStyle;
  playIntroOnLoad?: boolean;
  defaultRegion?: string;
  disabledRegions?: string[];
  profilePresetId?: string;
  presetId?: string;
  baseProfileId?: string;
  auPresetType?: string;
  profile?: Record<string, unknown>;
  auToMorphs?: Record<string, unknown>;
  auToBones?: Record<string, unknown>;
  morphToMesh?: Record<string, string[]>;
  markerGroups?: MarkerGroup[];
  lineDefaults?: LineConfig;
  markerDefaults?: Partial<MarkerStyleOverrides>;
}
export type CharacterConfig = AnnotationCharacterConfig;
export interface CharacterRegistry { characters: AnnotationCharacterConfig[]; defaultCharacter?: string; }
export type AUPresetType = string;
export type DPthreeRegion = AnnotationAnchoredRegion;
export type DPthreeCharacterConfig = AnnotationCharacterConfig;
export type DPthreeRegistry = CharacterRegistry;

/**
 * Camera state for save/restore
 */
export interface CameraState {
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * Configuration for DPthreeCameraController
 */
export interface DPthreeCameraControllerConfig {
  /** Optional selection override; otherwise selecting a region focuses the camera. */
  onRegionSelect?: (name: string) => void;
  /** Optional host profile intake; defaults to Embody preset resolution. */
  resolveCharacterConfig?: (config: AnnotationCharacterConfig) => AnnotationCharacterConfig | Promise<AnnotationCharacterConfig>;
  /** The Three.js camera to control */
  camera: THREE.PerspectiveCamera;
  /** DOM element for OrbitControls (usually the canvas or its container) */
  domElement: HTMLElement;
  /** The Three.js scene */
  scene: THREE.Scene;
  /** The Three.js renderer - if provided, camera controller manages the render loop */
  renderer?: THREE.WebGLRenderer;
  /**
   * Optional render callback used when the controller owns the render loop.
   * Allows overlay passes to render after the main character scene.
   */
  renderFrame?: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) => void;
  /**
   * Optional resize callback used when renderer sizing is owned by a higher-level
   * scene manager with its own pixel-ratio policy.
   */
  resizeRenderer?: (
    renderer: THREE.WebGLRenderer,
    width: number,
    height: number,
  ) => void;

  // OrbitControls settings
  /** Enable damping/inertia. Default: true */
  enableDamping?: boolean;
  /** Damping factor. Default: 0.05 */
  dampingFactor?: number;
  /** Minimum zoom distance. Default: 0.5 */
  minDistance?: number;
  /** Maximum zoom distance. Default: 10 */
  maxDistance?: number;

  // Animation settings
  /** Default transition duration in ms. Default: 800 */
  transitionDuration?: number;

  // Zoom padding factors (how much extra space around the target)
  /** Default padding factor. Default: 1.5 */
  zoomPaddingFactor?: number;
  /** Padding for small targets (eyes, mouth). Default: 1.2 */
  closeUpPaddingFactor?: number;
  /** Padding for full body view. Default: 2.0 */
  fullBodyPaddingFactor?: number;

  // DOM controls settings
  /** Show built-in annotation selector. Default: true */
  showDOMControls?: boolean;
  /** Container for DOM controls. Default: domElement */
  controlsContainer?: HTMLElement;
}

/**
 * Calculated focus position for camera animation
 */
export interface FocusPosition {
  position: THREE.Vector3;
  target: THREE.Vector3;
  distance: number;
}

/**
 * Callback for region change events
 */
export type RegionChangeCallback = (regionName: string) => void;

/**
 * Callback for character change events
 */
export type CharacterChangeCallback = (config: CharacterConfig) => void;

export type DPthreeRegionChangeCallback = RegionChangeCallback;
export type DPthreeCharacterChangeCallback = CharacterChangeCallback;
