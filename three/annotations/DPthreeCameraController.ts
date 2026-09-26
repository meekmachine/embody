import { boneResolutionProfile } from './boneResolutionProfile';
import { getAnnotationCameraCore, requireAnnotationCameraCore } from './annotationCameraCore';
import * as THREE from 'three';
import {
  detectAnnotationLaterality,
  fuzzyNameMatch,
  getDefaultAnnotationLaterality,
  resolveBoneNames,
  resolveFaceCenter,
  resolveRegionCameraAngle,
  type AnnotationLaterality,
} from './adapter';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  CameraDOMControls,
  RUNTIME_ANNOTATION_REGION_PREFIX,
  filterCameraViewRegions,
} from './DOMControls';
import { DPthree3DMarkers } from './DPthree3DMarkers';
import { DPthreeHTMLMarkers } from './DPthreeHTMLMarkers';
import { resolveAnnotationCharacterConfig } from './adapter';
import type {
  DPthreeCameraControllerConfig,
  CharacterConfig,
  Region,
  CameraState,
  FocusPosition,
  RegionChangeCallback,
  MarkerStyle,
  AnnotationAnchoredRegion,
  AnnotationFocusTarget,
  RuntimeAnnotationOptions,
  RuntimeAnnotationRegionSummary,
  RuntimeAnnotationSide,
} from './types';

/** Common interface for marker implementations */
interface DPthreeMarkers {
  setModel(model: THREE.Object3D): void;
  loadRegions(config: CharacterConfig, options?: { sliceSurfaceQueries?: boolean }): void | Promise<void>;
  setCurrentRegion(name: string | null): void;
  update(): void;
  updateRegion?(regionName: string, update: Partial<AnnotationAnchoredRegion>): void;
  removeRegion?(regionName: string): void;
  setVisible(visible: boolean): void;
  clear(): void;
  dispose(): void;
}

export function resolveFocusCameraDirection(
  model: THREE.Object3D | null,
  effectiveAngle: number,
  cameraAngle: number | undefined,
  angleSpace: 'model' | 'world' = 'model'
): THREE.Vector3 {
  const direction = requireAnnotationCameraCore().resolveFocusCameraDirection(
    model?.getWorldQuaternion(new THREE.Quaternion()),
    effectiveAngle,
    cameraAngle,
    angleSpace,
  );
  return new THREE.Vector3(direction.x, direction.y, direction.z);
}

export function resolveAutoCloseupAngle(
  horizontalOffset: number,
  focusSize: THREE.Vector3,
  modelSize: THREE.Vector3
): number | undefined {
  return requireAnnotationCameraCore().resolveAutoCloseupAngle(horizontalOffset, focusSize, modelSize);
}

type CameraPose = {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
};

type RustCameraAnimation = {
  sample(elapsedMs: number): CameraPose & { done: boolean };
  dispose(): void;
};

function toFocusPosition(framing: CameraPose & { distance: number }): FocusPosition {
  return {
    position: new THREE.Vector3(framing.position.x, framing.position.y, framing.position.z),
    target: new THREE.Vector3(framing.target.x, framing.target.y, framing.target.z),
    distance: framing.distance,
  };
}

export type MarkerStateSnapshot = {
  style: MarkerStyle;
  visible: boolean;
};

/**
 * Default configuration values
 */
const DEFAULTS = {
  enableDamping: true,
  dampingFactor: 0.05,
  minDistance: 0.5,
  maxDistance: 10,
  transitionDuration: 1400, // Slower, more graceful camera transitions
  zoomPaddingFactor: 1.5,
  closeUpPaddingFactor: 1.2,
  fullBodyPaddingFactor: 2.0,
  showDOMControls: true,
};

const INTRO_LEFT_EYE_PADDING_CAP = 0.85;
const INTRO_LEFT_EYE_PADDING_SCALE = 0.72;
const INTRO_LEFT_EYE_VERTICAL_BIAS_RATIO = 0.025;
const INTRO_LEFT_EYE_MIN_VERTICAL_BIAS = 0.025;
type RuntimeAnnotationProfileSource = {
  auToBones?: unknown;
  auToMorphs?: unknown;
  profile?: unknown;
};

type RuntimeAnnotationBoneTarget = {
  boneName: string;
  side?: RuntimeAnnotationSide;
};

type RuntimeAnnotationMorphTarget = {
  morphName: string;
  side?: RuntimeAnnotationSide;
};

type RuntimeAnnotationMorphSelection = {
  morphNames: string[];
  side?: RuntimeAnnotationSide;
};

type RuntimeAnnotationMeshTarget = {
  meshName: string;
  morphNames: string[];
  side?: RuntimeAnnotationSide;
};

type RuntimeAnnotationResolvedTargets = {
  bones: string[];
  meshTargets: RuntimeAnnotationMeshTarget[];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRuntimeAnnotationText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function readRuntimeAnnotationSide(value: unknown): RuntimeAnnotationSide | undefined {
  return value === 'left' || value === 'right' || value === 'center' ? value : undefined;
}

function inferRuntimeAnnotationSideFromText(value: string): RuntimeAnnotationSide | undefined {
  const normalized = value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const hasLeft = tokens.includes('left') || tokens.includes('l');
  const hasRight = tokens.includes('right') || tokens.includes('r');

  if (hasLeft === hasRight) return undefined;
  return hasLeft ? 'left' : 'right';
}

function encodeRuntimeAnnotationSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '~');
}

function getRuntimeAnnotationRegionLabel(region: AnnotationAnchoredRegion): string {
  return region.label ?? region.name;
}

function buildRuntimeAnnotationRegionSignature(region: AnnotationAnchoredRegion): string {
  return JSON.stringify({
    label: region.label,
    bones: region.bones,
    meshes: region.meshes,
    paddingFactor: region.paddingFactor,
    cameraAngle: region.cameraAngle,
    markerAnchor: region.markerAnchor,
    focusTarget: region.focusTarget,
    style: region.style,
    runtimeAnnotation: region.runtimeAnnotation,
  });
}

function buildRuntimeAnnotationStyle(
  options: RuntimeAnnotationOptions,
): AnnotationAnchoredRegion['style'] | undefined {
  const style: NonNullable<AnnotationAnchoredRegion['style']> = {};

  if (options.markerColor !== undefined) style.markerColor = options.markerColor;
  if (options.lineColor !== undefined) style.lineColor = options.lineColor;
  if (options.markerRadius !== undefined) style.markerRadius = options.markerRadius;
  if (options.labelColor !== undefined) style.labelColor = options.labelColor;
  if (options.labelBackground !== undefined) style.labelBackground = options.labelBackground;
  if (options.labelFontSize !== undefined) style.labelFontSize = options.labelFontSize;
  if (options.opacity !== undefined) style.opacity = options.opacity;

  return Object.keys(style).length > 0 ? style : undefined;
}

function getRuntimeAnnotationProfileCandidates(
  characterConfig: CharacterConfig | null,
  profileOverride?: unknown,
): RuntimeAnnotationProfileSource[] {
  const candidates: RuntimeAnnotationProfileSource[] = [];

  if (isPlainRecord(profileOverride)) {
    candidates.push(profileOverride);
    if (isPlainRecord(profileOverride.profile)) {
      candidates.push(profileOverride.profile);
    }
  }

  if (characterConfig) {
    candidates.push(characterConfig);
    if (isPlainRecord(characterConfig.profile)) {
      candidates.push(characterConfig.profile);
    }
  }

  return candidates;
}

function readRuntimeAnnotationBoneTarget(value: unknown): RuntimeAnnotationBoneTarget | null {
  if (typeof value === 'string') {
    const cleaned = value.trim();
    return cleaned.length > 0
      ? { boneName: cleaned, side: inferRuntimeAnnotationSideFromText(cleaned) }
      : null;
  }

  if (!isPlainRecord(value)) {
    return null;
  }

  const candidate = value.node ?? value.boneName ?? value.bone ?? value.name;
  if (typeof candidate !== 'string') {
    return null;
  }

  const cleaned = candidate.trim();
  return cleaned.length > 0
    ? {
      boneName: cleaned,
      side: readRuntimeAnnotationSide(value.side) ?? inferRuntimeAnnotationSideFromText(cleaned),
    }
    : null;
}

function readRuntimeAnnotationStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    const cleaned = entry.trim();
    return cleaned.length > 0 ? [cleaned] : [];
  });
}

function selectRuntimeAnnotationBoneTargets(
  targets: RuntimeAnnotationBoneTarget[],
  targetSide?: RuntimeAnnotationSide,
): RuntimeAnnotationBoneTarget[] {
  if (!targetSide) return targets;

  const preferredTargets = targets.filter((target) => target.side === targetSide);
  if (preferredTargets.length > 0) return preferredTargets;

  return targets.filter((target) => !target.side || target.side === 'center');
}

function resolveRuntimeAnnotationAUBoneTargets(
  auId: string,
  candidates: RuntimeAnnotationProfileSource[],
  targetSide?: RuntimeAnnotationSide,
): RuntimeAnnotationBoneTarget[] {
  const seen = new Set<string>();
  const boneTargets: RuntimeAnnotationBoneTarget[] = [];

  for (const candidate of candidates) {
    if (!isPlainRecord(candidate.auToBones)) continue;
    const bindings = candidate.auToBones[auId];
    if (!Array.isArray(bindings)) continue;

    for (const binding of bindings) {
      const target = readRuntimeAnnotationBoneTarget(binding);
      if (!target || seen.has(target.boneName)) continue;
      seen.add(target.boneName);
      boneTargets.push(target);
    }
  }

  return selectRuntimeAnnotationBoneTargets(boneTargets, targetSide);
}

function readRuntimeAnnotationMorphTargets(
  value: unknown,
  side?: RuntimeAnnotationSide,
): RuntimeAnnotationMorphTarget[] {
  return readRuntimeAnnotationStringArray(value).map((morphName) => ({
    morphName,
    side: side ?? inferRuntimeAnnotationSideFromText(morphName),
  }));
}

function resolveRuntimeAnnotationAUMorphSelection(
  auId: string,
  candidates: RuntimeAnnotationProfileSource[],
  targetSide?: RuntimeAnnotationSide,
): RuntimeAnnotationMorphSelection {
  const seen = new Set<string>();
  const morphTargets: RuntimeAnnotationMorphTarget[] = [];

  for (const candidate of candidates) {
    if (!isPlainRecord(candidate.auToMorphs)) continue;
    const mapping = candidate.auToMorphs[auId];
    const entries = isPlainRecord(mapping)
      ? [
        ...readRuntimeAnnotationMorphTargets(mapping.left, 'left'),
        ...readRuntimeAnnotationMorphTargets(mapping.right, 'right'),
        ...readRuntimeAnnotationMorphTargets(mapping.center, 'center'),
      ]
      : readRuntimeAnnotationMorphTargets(mapping);

    for (const target of entries) {
      if (seen.has(target.morphName)) continue;
      seen.add(target.morphName);
      morphTargets.push(target);
    }
  }

  const selectedTargets = targetSide
    ? (() => {
      const preferredTargets = morphTargets.filter((target) => target.side === targetSide);
      if (preferredTargets.length > 0) return preferredTargets;
      return morphTargets.filter((target) => !target.side || target.side === 'center');
    })()
    : morphTargets;

  const hasPreferredSide = targetSide && selectedTargets.some((target) => target.side === targetSide);
  const hasOnlyCenterSide = selectedTargets.length > 0 && selectedTargets.every((target) => target.side === 'center');

  return {
    morphNames: selectedTargets.map((target) => target.morphName),
    side: hasPreferredSide
      ? targetSide
      : hasOnlyCenterSide
        ? 'center'
        : targetSide && selectedTargets.length > 0
          ? targetSide
          : undefined,
  };
}

function resolveRuntimeAnnotationMorphMeshes(
  morphNames: string[],
  morphTargetsByMesh?: unknown,
  side?: RuntimeAnnotationSide,
): RuntimeAnnotationMeshTarget[] {
  if (!isPlainRecord(morphTargetsByMesh) || morphNames.length === 0) {
    return [];
  }

  const requestedByLowerName = new Map<string, string>();
  for (const morphName of morphNames) {
    requestedByLowerName.set(morphName.toLowerCase(), morphName);
  }

  const meshTargets: RuntimeAnnotationMeshTarget[] = [];
  for (const [meshName, targets] of Object.entries(morphTargetsByMesh)) {
    const matched = new Set<string>();
    for (const targetName of readRuntimeAnnotationStringArray(targets)) {
      const requestedName = requestedByLowerName.get(targetName.toLowerCase());
      if (requestedName) {
        matched.add(requestedName);
      }
    }
    if (matched.size > 0) {
      meshTargets.push({ meshName, morphNames: Array.from(matched), side });
    }
  }

  return meshTargets.sort(compareRuntimeAnnotationMeshTargets);
}

function getRuntimeAnnotationMeshTargetScore(target: RuntimeAnnotationMeshTarget): number {
  const meshName = target.meshName.toLowerCase();
  const morphText = target.morphNames.join(' ').toLowerCase();
  let score = 0;

  if (/brow|forehead|frontalis/.test(morphText)) {
    if (/brow|eyebrow|bushy/.test(meshName)) score -= 100;
    if (/body|skin|head/.test(meshName)) score += 20;
    if (/eyeocclusion|tearline/.test(meshName)) score += 40;
  } else if (/mouth|lip|smile|frown|dimple|pucker|stretch|press|funnel|roll|shrug|close|jaw|chin/.test(morphText)) {
    if (/body|skin|head/.test(meshName)) score -= 100;
    if (/brow|eyebrow|bushy|hair|eyeocclusion|tearline/.test(meshName)) score += 80;
  } else if (/eye|lid|blink|squint|wide/.test(morphText)) {
    if (/eyeocclusion|tearline|eye/.test(meshName)) score -= 80;
    if (/body|skin|head/.test(meshName)) score += 10;
    if (/brow|eyebrow|bushy|hair/.test(meshName)) score += 60;
  } else if (/tongue/.test(morphText)) {
    if (/tongue/.test(meshName)) score -= 100;
  }

  return score;
}

function compareRuntimeAnnotationMeshTargets(
  left: RuntimeAnnotationMeshTarget,
  right: RuntimeAnnotationMeshTarget,
): number {
  const scoreDelta = getRuntimeAnnotationMeshTargetScore(left) - getRuntimeAnnotationMeshTargetScore(right);
  if (scoreDelta !== 0) return scoreDelta;

  return left.meshName.localeCompare(right.meshName);
}

function resolveRuntimeAnnotationTargetLimit(
  options: RuntimeAnnotationOptions,
): number | null {
  const maxTargets = options.maxTargets;
  if (typeof maxTargets !== 'number' || !Number.isFinite(maxTargets) || maxTargets < 1) {
    return null;
  }

  return Math.floor(maxTargets);
}

function limitRuntimeAnnotationTargets(
  bones: string[],
  meshTargets: RuntimeAnnotationMeshTarget[],
  options: RuntimeAnnotationOptions,
): RuntimeAnnotationResolvedTargets {
  const maxTargets = resolveRuntimeAnnotationTargetLimit(options);
  if (maxTargets === null || bones.length + meshTargets.length <= maxTargets) {
    return { bones, meshTargets };
  }

  const limitedBones: string[] = [];
  const limitedMeshTargets: RuntimeAnnotationMeshTarget[] = [];

  const takeBones = () => {
    for (const boneName of bones) {
      if (limitedBones.length + limitedMeshTargets.length >= maxTargets) return;
      limitedBones.push(boneName);
    }
  };
  const takeMeshTargets = () => {
    for (const meshTarget of meshTargets) {
      if (limitedBones.length + limitedMeshTargets.length >= maxTargets) return;
      limitedMeshTargets.push(meshTarget);
    }
  };

  if (options.targetPreference === 'mesh') {
    takeMeshTargets();
    takeBones();
  } else {
    takeBones();
    takeMeshTargets();
  }

  return {
    bones: limitedBones,
    meshTargets: limitedMeshTargets,
  };
}

/**
 * DPthreeCameraController - A unified camera controller for character viewers
 *
 * Features:
 * - OrbitControls wrapper for smooth camera interaction
 * - Focus on specific bones, meshes, or named regions
 * - Smart bounding box calculation with size-based padding
 * - Smooth animated transitions between views
 * - Self-contained DOM controls for region selection
 *
 * Designed for future NPM packaging - no React dependencies.
 */
export class DPthreeCameraController {
  // Public readonly properties
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly scene: THREE.Scene;

  private readonly resolveCharacterConfig: NonNullable<DPthreeCameraControllerConfig['resolveCharacterConfig']>;
  private readonly selectRegion: (name: string) => void;

  // Configuration
  private config: Required<
    Pick<
      DPthreeCameraControllerConfig,
      | 'enableDamping'
      | 'dampingFactor'
      | 'minDistance'
      | 'maxDistance'
      | 'transitionDuration'
      | 'zoomPaddingFactor'
      | 'closeUpPaddingFactor'
      | 'fullBodyPaddingFactor'
      | 'showDOMControls'
    >
  >;
  private controlsContainer: HTMLElement;

  // State
  private model: THREE.Object3D | null = null;
  private regions: AnnotationAnchoredRegion[] = [];
  private currentRegion: string | null = null;
  private characterConfig: CharacterConfig | null = null;
  private runtimeAnnotationRegionNames = new Set<string>();

  // Animation state - driven by update() in render loop
  private timerAnimationFallbackToken = 0;
  private cameraRequestGeneration = 0;
  private regionLoadGeneration = 0;
  private disposed = false;
  private pendingAnimation: {
    startTime: number;
    runtime: RustCameraAnimation;
    resolve: () => void;
  } | null = null;

  // DOM Controls
  private domControls: CameraDOMControls | null = null;

  // Markers (can be 3D or HTML style)
  private markers: DPthreeMarkers | null = null;
  private currentMarkerStyle: MarkerStyle = '3d';
  private markersLoaded = false;
  private markersVisible = false;
  private markerStateListeners = new Set<(state: MarkerStateSnapshot) => void>();
  private domElement: HTMLElement;

  // Renderer and render loop (when controller manages the render loop)
  private renderer: THREE.WebGLRenderer | null = null;
  private renderFrame:
    ((renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) => void)
    | null = null;
  private resizeRenderer:
    ((renderer: THREE.WebGLRenderer, width: number, height: number) => void)
    | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private boundResizeHandler: (() => void) | null = null;
  private laterality: AnnotationLaterality = getDefaultAnnotationLaterality();

  // Callbacks
  private onRegionChangeCallbacks: RegionChangeCallback[] = [];

  constructor(inputConfig: DPthreeCameraControllerConfig) {
    this.resolveCharacterConfig = inputConfig.resolveCharacterConfig ?? resolveAnnotationCharacterConfig;
    this.selectRegion = inputConfig.onRegionSelect ?? ((name) => { void this.focusRegion(name); });
    this.camera = inputConfig.camera;
    this.scene = inputConfig.scene;
    this.domElement = inputConfig.domElement;
    this.controlsContainer = inputConfig.controlsContainer || inputConfig.domElement;

    // Merge config with defaults
    this.config = {
      enableDamping: inputConfig.enableDamping ?? DEFAULTS.enableDamping,
      dampingFactor: inputConfig.dampingFactor ?? DEFAULTS.dampingFactor,
      minDistance: inputConfig.minDistance ?? DEFAULTS.minDistance,
      maxDistance: inputConfig.maxDistance ?? DEFAULTS.maxDistance,
      transitionDuration: inputConfig.transitionDuration ?? DEFAULTS.transitionDuration,
      zoomPaddingFactor: inputConfig.zoomPaddingFactor ?? DEFAULTS.zoomPaddingFactor,
      closeUpPaddingFactor: inputConfig.closeUpPaddingFactor ?? DEFAULTS.closeUpPaddingFactor,
      fullBodyPaddingFactor: inputConfig.fullBodyPaddingFactor ?? DEFAULTS.fullBodyPaddingFactor,
      showDOMControls: inputConfig.showDOMControls ?? DEFAULTS.showDOMControls,
    };

    // Set initial camera position before creating OrbitControls
    // This ensures camera isn't at origin (inside model)
    this.camera.position.set(0, 1, 3);

    // Create OrbitControls
    this.controls = new OrbitControls(this.camera, inputConfig.domElement);
    this.controls.enableDamping = this.config.enableDamping;
    this.controls.dampingFactor = this.config.dampingFactor;
    this.controls.minDistance = this.config.minDistance;
    this.controls.maxDistance = this.config.maxDistance;

    // Set initial target to roughly character center height
    this.controls.target.set(0, 1, 0);
    this.controls.update();

    // Initialize DOM controls if enabled
    if (this.config.showDOMControls) {
      this.initDOMControls();
    }

    // Store renderer and start render loop if provided
    if (inputConfig.renderer) {
      this.renderer = inputConfig.renderer;
      this.renderFrame = inputConfig.renderFrame ?? null;
      this.resizeRenderer = inputConfig.resizeRenderer ?? null;
      this.startRenderLoop();
      this.setupResizeHandling();
    }

    // Markers will be initialized when loadRegions is called
    // based on the character's markerStyle preference
  }

  /**
   * Start the render loop (only when renderer is provided)
   */
  private startRenderLoop(): void {
    if (!this.renderer) return;

    this.renderer.setAnimationLoop(() => {
      this.update();
      if (this.renderFrame) {
        this.renderFrame(this.renderer!, this.scene, this.camera);
        return;
      }
      this.renderer!.render(this.scene, this.camera);
    });
  }

  /**
   * Stop the render loop
   */
  private stopRenderLoop(): void {
    if (this.renderer) {
      this.renderer.setAnimationLoop(null);
    }
  }

  private shouldDriveTimerAnimationFallback(): boolean {
    return !this.renderer;
  }

  private getTimerAnimationFallbackDelay(): number {
    return 16;
  }

  private scheduleTimerAnimationFallback(hasPendingAnimation: () => boolean): void {
    if (!this.shouldDriveTimerAnimationFallback()) return;

    const token = ++this.timerAnimationFallbackToken;
    const tick = () => {
      if (token !== this.timerAnimationFallbackToken || !hasPendingAnimation()) return;

      this.update();

      if (token === this.timerAnimationFallbackToken && hasPendingAnimation()) {
        setTimeout(tick, this.getTimerAnimationFallbackDelay());
      }
    };

    setTimeout(tick, this.getTimerAnimationFallbackDelay());
  }

  /**
   * Set up resize handling for the renderer
   * Uses ResizeObserver for container size changes
   */
  private setupResizeHandling(): void {
    if (!this.renderer) return;

    const container = this.domElement.parentElement || this.domElement;

    // Create resize handler
    this.boundResizeHandler = () => {
      const width = container.clientWidth || window.innerWidth;
      const height = container.clientHeight || window.innerHeight;

      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();

      if (this.renderer) {
        if (this.resizeRenderer) {
          this.resizeRenderer(this.renderer, width, height);
        } else {
          this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
          this.renderer.setSize(width, height, false);
        }
      }
    };

    // Use ResizeObserver for container size changes
    this.resizeObserver = new ResizeObserver(this.boundResizeHandler);
    this.resizeObserver.observe(container);

    // Also listen to window resize as fallback
    window.addEventListener('resize', this.boundResizeHandler);
  }

  /**
   * Clean up resize handling
   */
  private cleanupResizeHandling(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.boundResizeHandler) {
      window.removeEventListener('resize', this.boundResizeHandler);
      this.boundResizeHandler = null;
    }
  }

  // ====== CORE PUBLIC METHODS ======

  /**
   * Set the model to use for bone/mesh lookups
   * Must be called after model loads
   */
  setModel(model: THREE.Object3D): void {
    if (this.disposed) return;
    this.regionLoadGeneration += 1;
    this.cameraRequestGeneration += 1;
    this.cancelCameraAnimation();
    this.model = model;
    this.markers?.setModel(model);

    // Force update world matrices
    this.scene.updateMatrixWorld(true);
    if (this.characterConfig && this.regions.length > 0) {
      this.refreshLaterality();
    }
  }

  /**
   * Load region config for a character
   */
  async loadRegions(config: CharacterConfig): Promise<void> {
    if (this.disposed) return;
    const request = ++this.regionLoadGeneration;
    const model = this.model;
    const runtimeConfig = await this.resolveCharacterConfig(config);
    if (!this.isRegionLoadCurrent(request, model)) return;
    await this.prepareRegionsAndMarkersForReveal(runtimeConfig);
  }

  /**
   * Prime an already-resolved runtime config before the character becomes visible.
   * Marker construction is intentionally separate so startup can defer the expensive
   * per-region marker geometry/DOM work until after the first visible frame.
   */
  prepareRegionsForReveal(config: CharacterConfig): void {
    if (this.disposed) return;
    this.prepareRegionState(config);
    this.startPreparedCameraTransition(config);
  }

  /**
   * Prepare marker geometry while the character loading overlay is still up,
   * then start the intro camera transition after that work has completed.
   */
  async prepareRegionsAndMarkersForReveal(
    config: CharacterConfig,
    beforeReveal?: () => Promise<boolean>,
  ): Promise<void> {
    if (this.disposed) return;
    this.prepareRegionState(config);
    const request = this.regionLoadGeneration;
    const model = this.model;
    // The character has not started animating yet, so surface queries can span
    // frames without sampling different poses within the same marker.
    await this.loadMarkersForCurrentRegions(true);

    if (!this.isRegionLoadCurrent(request, model) || this.characterConfig !== config) return;
    if (beforeReveal && !await beforeReveal()) return;
    if (this.isRegionLoadCurrent(request, model) && this.characterConfig === config) {
      this.startPreparedCameraTransition(config);
    }
  }

  private prepareRegionState(config: CharacterConfig): void {
    this.regionLoadGeneration += 1;
    this.cameraRequestGeneration += 1;
    this.cancelCameraAnimation();
    this.characterConfig = config;
    this.regions = config.regions ?? [];
    this.currentRegion = null;
    this.runtimeAnnotationRegionNames.clear();
    this.markersLoaded = false;
    this.refreshLaterality();
    this.updateDOMControls();
    this.setMarkerStyleState(config.markerStyle ?? '3d');
  }

  private startPreparedCameraTransition(config: CharacterConfig): void {
    // Play intro animation or focus default region
    if (config.playIntroOnLoad) {
      // Play intro animation (orbit + zoom to torso)
      this.playIntroAnimation();
    } else if (config.defaultRegion) {
      // Focus default region if specified (immediate, no animation)
      this.focusRegion(config.defaultRegion, 0);
    }
  }

  /**
   * Build marker objects for the current character config.
   * This is separated from prepareRegionsForReveal so callers can defer the
   * expensive marker construction until after the first visible frame.
   */
  async loadMarkersForCurrentRegions(sliceSurfaceQueries = false): Promise<void> {
    if (this.disposed || !this.characterConfig) {
      return;
    }

    const characterConfig = this.characterConfig;
    const request = this.regionLoadGeneration;
    const model = this.model;
    this.ensureMarkersForCurrentStyle();
    const markers = this.markers;
    if (!markers) return;
    markers.setVisible(this.markersVisible);
    await markers.loadRegions(characterConfig, { sliceSurfaceQueries });
    if (!this.isRegionLoadCurrent(request, model) || markers !== this.markers || characterConfig !== this.characterConfig) {
      return;
    }

    if (this.currentRegion) {
      markers.setCurrentRegion(this.currentRegion);
    }
    markers.setVisible(this.markersVisible);
    this.markersLoaded = true;
  }

  /**
   * Focus on a named region from the loaded config
   */
  async focusRegion(name: string, duration?: number): Promise<void> {
    const region = this.regions.find((a) => a.name === name);
    if (!region) {
      return;
    }

    if (await this.beginCameraRequest() === null) return;

    this.currentRegion = name;
    this.notifyRegionChange(name);

    const focusPos = this.resolveRegionFocusPosition(region);
    if (!focusPos) {
      return;
    }

    // Apply camera offset if specified
    if (region.cameraOffset) {
      if (region.cameraOffset.x) focusPos.position.x += region.cameraOffset.x;
      if (region.cameraOffset.y) focusPos.position.y += region.cameraOffset.y;
      if (region.cameraOffset.z) focusPos.position.z += region.cameraOffset.z;
    }

    await this.animateCamera(focusPos.position, focusPos.target, duration ?? this.config.transitionDuration);
  }

  private resolveRegionFocusPosition(region: Region): FocusPosition | null {
    const focusTarget = (region as AnnotationAnchoredRegion).focusTarget;
    if (!focusTarget || focusTarget.type === 'region') {
      return this.resolveLegacyRegionFocusPosition(
        region,
        focusTarget?.paddingFactor,
        focusTarget?.cameraAngle,
      );
    }

    const paddingFactor = focusTarget.paddingFactor ?? region.paddingFactor;
    const cameraAngle = focusTarget.cameraAngle ?? resolveRegionCameraAngle(region, this.laterality);

    if (focusTarget.type === 'point') {
      if (!focusTarget.position) return null;
      return this.calculatePointFocusPosition(
        new THREE.Vector3(
          focusTarget.position.x,
          focusTarget.position.y,
          focusTarget.position.z,
        ),
        paddingFactor,
        cameraAngle,
      );
    }

    if (focusTarget.type === 'face-center') {
      if (!this.model) return null;
      const faceRegion: Region = {
        ...region,
        bones: focusTarget.bones ?? region.bones,
        meshes: focusTarget.meshes ?? region.meshes,
        objects: focusTarget.objects ?? region.objects,
      };
      const faceCenter = resolveFaceCenter(this.model as any, faceRegion as any, boneResolutionProfile(this.characterConfig) ?? undefined);
      return this.calculatePointFocusPosition(
        new THREE.Vector3(
          faceCenter.center.x,
          faceCenter.center.y,
          faceCenter.center.z,
        ),
        paddingFactor,
        cameraAngle,
      );
    }

    const objects = this.resolveFocusTargetObjects(region, focusTarget);
    if (objects.length === 0) {
      return null;
    }

    return this.calculateFocusPosition(objects, paddingFactor, cameraAngle);
  }

  private resolveLegacyRegionFocusPosition(
    region: Region,
    overridePadding?: number,
    overrideCameraAngle?: number,
  ): FocusPosition | null {
    if (this.isFullBodyRegion(region)) {
      if (!this.model) {
        return null;
      }
      return this.calculateFullBodyFocusPosition(
        overridePadding ?? region.paddingFactor,
        overrideCameraAngle,
      );
    }

    const objects = this.resolveRegionObjects(region);
    if (objects.length === 0) {
      return null;
    }

    return this.calculateFocusPosition(
      objects,
      overridePadding ?? region.paddingFactor,
      overrideCameraAngle ?? resolveRegionCameraAngle(region, this.laterality),
    );
  }

  private resolveFocusTargetObjects(
    region: Region,
    focusTarget: AnnotationFocusTarget,
  ): THREE.Object3D[] {
    if (focusTarget.type === 'bone') {
      const boneNames = focusTarget.bones ?? region.bones ?? [];
      return this.findObjectsByNames(resolveBoneNames(boneNames, boneResolutionProfile(this.characterConfig)), 'Bone');
    }

    if (focusTarget.type === 'mesh') {
      return this.findObjectsByNames(focusTarget.meshes ?? region.meshes ?? [], 'Mesh');
    }

    if (focusTarget.type === 'object') {
      return this.resolveRegionObjects({
        ...region,
        bones: undefined,
        meshes: undefined,
        objects: focusTarget.objects ?? region.objects,
      });
    }

    return [];
  }

  /**
   * Focus on specific bones by name
   */
  async focusBones(boneNames: string[], duration?: number): Promise<void> {
    const objects = this.findObjectsByNames(boneNames, 'Bone');
    if (objects.length === 0) {
      return;
    }

    if (await this.beginCameraRequest() === null) return;

    const focusPos = this.calculateFocusPosition(objects);
    await this.animateCamera(focusPos.position, focusPos.target, duration ?? this.config.transitionDuration);
  }

  /**
   * Focus on specific meshes by name
   */
  async focusMeshes(meshNames: string[], duration?: number): Promise<void> {
    const objects = this.findObjectsByNames(meshNames, 'Mesh');
    if (objects.length === 0) {
      return;
    }

    if (await this.beginCameraRequest() === null) return;

    const focusPos = this.calculateFocusPosition(objects);
    await this.animateCamera(focusPos.position, focusPos.target, duration ?? this.config.transitionDuration);
  }

  /**
   * Focus on the full body (entire model bounding box)
   */
  async focusFullBody(duration?: number): Promise<void> {
    if (!this.model) {
      return;
    }

    if (await this.beginCameraRequest() === null) return;

    const focusPos = this.calculateFullBodyFocusPosition();
    await this.animateCamera(focusPos.position, focusPos.target, duration ?? this.config.transitionDuration);
  }

  /**
   * Focus on arbitrary objects
   */
  async focusObjects(objects: THREE.Object3D[], duration?: number): Promise<void> {
    if (objects.length === 0) {
      return;
    }

    if (await this.beginCameraRequest() === null) return;

    const focusPos = this.calculateFocusPosition(objects);
    await this.animateCamera(focusPos.position, focusPos.target, duration ?? this.config.transitionDuration);
  }

  /**
   * Play intro animation: orbit around the character, then settle into a tight
   * left-eye hero closeup when the character provides a left-eye region.
   * @param orbitDuration - Duration of the 360° orbit in ms (default: 3000)
   * @param zoomDuration - Duration of the final zoom in ms (default: 1500)
   */
  async playIntroAnimation(orbitDuration = 3000, zoomDuration = 1500): Promise<void> {
    const request = await this.beginCameraRequest();
    if (request === null) return;

    if (!this.model) {
      return;
    }

    // Force update world matrices to ensure all geometry positions are current
    this.scene.updateMatrixWorld(true);

    // Get full model bounds - includes all meshes and their current deformed positions
    const box = new THREE.Box3().setFromObject(this.model);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    // Calculate orbit parameters based on full model extent
    // Use the maximum horizontal extent (X or Z) to ensure we clear all geometry including fins
    const horizontalExtent = Math.max(size.x, size.z);
    const verticalExtent = size.y;

    // Orbit distance: far enough to see the full model from any angle
    // Include extra padding to account for fins and other protrusions
    const orbitRadius = Math.max(horizontalExtent, verticalExtent) * 1.8;

    // Orbit height: centered on the model with a slight upward bias
    const orbitHeight = center.y;

    // The Rust orbit owns both the initial pose and all subsequent samples.
    await this.animateOrbit(center, orbitRadius, orbitHeight, orbitDuration);
    if (!this.isCameraRequestCurrent(request)) return;

    const leftEyeRegion = this.findIntroLeftEyeRegion();
    const leftEyeFocus = leftEyeRegion
      ? this.calculateIntroLeftEyeFocusPosition(leftEyeRegion)
      : null;
    if (leftEyeFocus && leftEyeRegion) {
      await this.animateCamera(leftEyeFocus.position, leftEyeFocus.target, zoomDuration);
      if (!this.isCameraRequestCurrent(request)) return;
      this.currentRegion = leftEyeRegion.name;
      this.notifyRegionChange(leftEyeRegion.name);
      return;
    }

    const finalAngle = -30; // degrees, matching the legacy 11 o'clock intro landing
    const fullBodyRegion = this.regions.find((region) => this.isFullBodyRegion(region));
    const focusPos = this.calculateFullBodyFocusPosition(fullBodyRegion?.paddingFactor, finalAngle, 'world');

    await this.animateCamera(focusPos.position, focusPos.target, zoomDuration);
    if (!this.isCameraRequestCurrent(request)) return;

    if (fullBodyRegion) {
      this.currentRegion = fullBodyRegion.name;
      this.notifyRegionChange(fullBodyRegion.name);
    }
  }

  /**
   * Animate a smooth 360° orbit around a center point
   * Animation is driven by the update() method which is called from the render loop.
   */
  private animateOrbit(
    center: THREE.Vector3,
    radius: number,
    height: number,
    duration: number
  ): Promise<void> {
    return this.runCameraAnimation(
      requireAnnotationCameraCore().createCameraOrbit(center, radius, height, duration),
    );
  }

  // ====== CONFIG/STATE METHODS ======

  /**
   * Get list of available region names
   */
  getRegionNames(): string[] {
    return this.regions.map((a) => a.name);
  }

  /**
   * Get current region name
   */
  getCurrentRegion(): string | null {
    return this.currentRegion;
  }

  /**
   * Get loaded character config
   */
  getCharacterConfig(): CharacterConfig | null {
    return this.characterConfig;
  }

  /**
   * Get current camera state
   */
  getCameraState(): CameraState {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
    };
  }

  /**
   * Set camera state directly (no animation)
   */
  setCameraState(state: CameraState): void {
    this.cameraRequestGeneration += 1;
    this.cancelCameraAnimation();
    this.camera.position.set(...state.position);
    this.controls.target.set(...state.target);
    this.controls.update();
  }

  /**
   * Animate to camera state
   */
  async animateToCameraState(state: CameraState, duration?: number): Promise<void> {
    if (await this.beginCameraRequest() === null) return;

    const targetPosition = new THREE.Vector3(...state.position);
    const targetLookAt = new THREE.Vector3(...state.target);
    await this.animateCamera(targetPosition, targetLookAt, duration ?? this.config.transitionDuration);
  }

  // ====== MARKERS ======

  /**
   * Show/hide region markers
   */
  setMarkersVisible(visible: boolean): void {
    if (this.disposed) return;
    // Keep startup light by only constructing markers once something actually
    // requests that they be shown.
    if (visible && !this.markersLoaded && this.characterConfig) {
      void this.loadMarkersForCurrentRegions();
    }

    if (this.markersVisible === visible) return;
    this.markersVisible = visible;
    this.markers?.setVisible(visible);
    this.domControls?.setMarkersVisible(visible);
    this.emitMarkerState();
  }

  /**
   * Get current markers visibility state
   */
  getMarkersVisible(): boolean {
    return this.markersVisible;
  }

  /**
   * Clear all markers and reset region state
   */
  clearMarkers(): void {
    if (this.disposed) return;
    this.regionLoadGeneration += 1;
    this.cameraRequestGeneration += 1;
    this.cancelCameraAnimation();
    this.markers?.clear();
    this.markersLoaded = false;
    this.regions = [];
    this.currentRegion = null;
    this.characterConfig = null;
    this.runtimeAnnotationRegionNames.clear();
    if (this.currentMarkerStyle !== '3d') {
      this.currentMarkerStyle = '3d';
      this.emitMarkerState();
    }
    this.updateDOMControls();
  }

  /**
   * Get current marker style
   */
  getMarkerStyle(): MarkerStyle {
    return this.currentMarkerStyle;
  }

  /**
   * Set marker style (html or 3d) - recreates markers with new style
   */
  setMarkerStyle(style: MarkerStyle): void {
    if (this.disposed) return;
    console.log(`[CameraController] setMarkerStyle: ${this.currentMarkerStyle} -> ${style}`);
    if (style === this.currentMarkerStyle) return;

    this.setMarkerStyleState(style);

    // If startup intentionally deferred marker construction, just remember the
    // new style and let the deferred load build the correct marker flavor.
    if (!this.markersLoaded) {
      this.markers?.dispose();
      this.markers = null;
      return;
    }

    void this.loadMarkersForCurrentRegions();
  }

  private setMarkerStyleState(style: MarkerStyle): void {
    if (style === this.currentMarkerStyle) {
      return;
    }

    this.currentMarkerStyle = style;
    this.emitMarkerState();
  }

  private ensureMarkersForCurrentStyle(): void {
    if (this.markers) {
      this.markers.dispose();
      this.markers = null;
    }

    if (this.currentMarkerStyle === 'html') {
      this.markers = new DPthreeHTMLMarkers({
        scene: this.scene,
        camera: this.camera,
        domElement: this.domElement,
        onSelect: this.selectRegion,
      });
    } else {
      this.markers = new DPthree3DMarkers({
        scene: this.scene,
        camera: this.camera,
        domElement: this.domElement,
        onSelect: this.selectRegion,
      });
    }

    console.log(`[CameraController] Created ${this.currentMarkerStyle} markers, has model: ${!!this.model}, has config: ${!!this.characterConfig}`);

    if (this.model) {
      this.markers.setModel(this.model);
    }
  }

  subscribeMarkerState(listener: (state: MarkerStateSnapshot) => void): () => void {
    this.markerStateListeners.add(listener);
    listener(this.getMarkerState());
    return () => {
      this.markerStateListeners.delete(listener);
    };
  }

  private getMarkerState(): MarkerStateSnapshot {
    return {
      style: this.currentMarkerStyle,
      visible: this.markersVisible,
    };
  }

  private emitMarkerState(): void {
    const snapshot = this.getMarkerState();
    for (const listener of this.markerStateListeners) {
      listener(snapshot);
    }
  }

  // ====== MARKER STYLING ======

  /**
   * Solo a marker - show only this marker, hide all others
   * @param regionName - Region to solo (null to unsolo all)
   */
  soloMarker(regionName: string | null): void {
    if (this.markers && 'setSoloMarker' in this.markers) {
      (this.markers as DPthree3DMarkers).setSoloMarker(regionName);
    }
  }

  /**
   * Get currently soloed marker name (or null)
   */
  getSoloedMarker(): string | null {
    if (this.markers && 'getSoloedMarker' in this.markers) {
      return (this.markers as DPthree3DMarkers).getSoloedMarker();
    }
    return null;
  }

  /**
   * Expand a region to show its children
   * @param regionName - Name of the parent region to expand
   * @param duration - Animation duration in ms (default: 400)
   */
  expandRegion(regionName: string, duration?: number): void {
    if (this.markers && 'expandRegion' in this.markers) {
      (this.markers as DPthree3DMarkers).expandRegion(regionName, 'outward', duration);
    }
  }

  /**
   * Collapse a region to hide its children
   * @param regionName - Name of the parent region to collapse
   * @param duration - Animation duration in ms (default: 300)
   */
  collapseRegion(regionName: string, duration?: number): void {
    if (this.markers && 'collapseRegion' in this.markers) {
      (this.markers as DPthree3DMarkers).collapseRegion(regionName, duration);
    }
  }

  /**
   * Toggle expand/collapse state of a region
   * @param regionName - Name of the parent region to toggle
   * @param animation - Animation style: 'outward' or 'staggered'
   * @param duration - Animation duration in ms
   */
  toggleRegion(regionName: string, animation: 'outward' | 'staggered' = 'outward', duration?: number): void {
    if (this.markers && 'toggleRegion' in this.markers) {
      (this.markers as DPthree3DMarkers).toggleRegion(regionName, animation, duration);
    }
  }

  /**
   * Get current expanded state of all regions
   */
  getExpandedRegions(): { regionName: string; isExpanded: boolean; children: string[] }[] {
    if (this.markers && 'getExpandedRegions' in this.markers) {
      return (this.markers as DPthree3DMarkers).getExpandedRegions();
    }
    return [];
  }

  /**
   * Update line style for a specific region at runtime
   */
  setRegionLineStyle(regionName: string, lineConfig: { style?: 'solid' | 'dashed' | 'dotted'; curve?: 'straight' | 'bezier' | 'arc'; arrowHead?: boolean; thickness?: number; length?: number }): void {
    console.log(`[CameraController] setRegionLineStyle: region=${regionName}, markerStyle=${this.currentMarkerStyle}`, lineConfig);
    if (this.markers && 'updateLineStyle' in this.markers) {
      (this.markers as DPthree3DMarkers).updateLineStyle(regionName, lineConfig);
    } else {
      console.warn(`[CameraController] updateLineStyle not available (markers: ${!!this.markers}, method: ${'updateLineStyle' in (this.markers || {})})`);
    }
  }

  /**
   * Update marker style for a specific region at runtime
   */
  setRegionStyle(regionName: string, style: { markerColor?: number; markerRadius?: number; lineColor?: number; labelColor?: string; labelBackground?: string; labelFontSize?: number; opacity?: number }): void {
    console.log(`[CameraController] setRegionStyle: region=${regionName}, markerStyle=${this.currentMarkerStyle}`, style);
    if (this.markers && 'updateMarkerStyle' in this.markers) {
      (this.markers as DPthree3DMarkers).updateMarkerStyle(regionName, style);
    } else {
      console.warn(`[CameraController] updateMarkerStyle not available (markers: ${!!this.markers}, method: ${'updateMarkerStyle' in (this.markers || {})})`);
    }
  }

  /**
   * Update the face mesh configuration for a region and recalculate its position.
   * This is called when the user selects a different face mesh in the wizard.
   *
   * @param regionName - Name of the region to update (e.g., 'face')
   * @param meshNames - Array of mesh names to use for positioning
   */
  updateRegionMeshes(regionName: string, meshNames: string[]): void {
    console.log(`[CameraController] updateRegionMeshes: region=${regionName}, meshes=${meshNames.join(', ')}`);
    if (this.markers && 'updateRegionMeshes' in this.markers) {
      (this.markers as DPthree3DMarkers).updateRegionMeshes(regionName, meshNames);
    } else {
      console.warn(`[CameraController] updateRegionMeshes not available (markers: ${!!this.markers}, method: ${'updateRegionMeshes' in (this.markers || {})})`);
    }
  }

  /**
   * Reposition an existing marker to a new position.
   *
   * @param regionName - Name of the region to reposition
   * @param position - New world position { x, y, z }
   */
  repositionMarker(regionName: string, position: { x: number; y: number; z: number }): void {
    console.log(`[CameraController] repositionMarker: ${regionName} -> (${position.x.toFixed(3)}, ${position.y.toFixed(3)}, ${position.z.toFixed(3)})`);
    if (this.markers && 'repositionMarker' in this.markers) {
      const vec = new THREE.Vector3(position.x, position.y, position.z);
      (this.markers as DPthree3DMarkers).repositionMarker(regionName, vec);
    } else {
      console.warn(`[CameraController] repositionMarker not available`);
    }
  }

  /**
   * Get the current position of a marker
   */
  getMarkerPosition(regionName: string): { x: number; y: number; z: number } | null {
    if (this.markers && 'getMarkerPosition' in this.markers) {
      const pos = (this.markers as DPthree3DMarkers).getMarkerPosition(regionName);
      return pos ? { x: pos.x, y: pos.y, z: pos.z } : null;
    }
    return null;
  }

  /**
   * Get the current model reference
   */
  getModel(): THREE.Object3D | null {
    return this.model;
  }

  /**
   * Remove an annotation region from the active runtime config and marker set.
   *
   * Persistence still happens through the canonical profile annotation overrides
   * saved by the authoring UI; this only keeps the live scene in sync.
   */
  removeAnnotationRegion(regionName: string): void {
    if (this.disposed) return;
    this.runtimeAnnotationRegionNames.delete(regionName);
    const nextRegions = this.regions.filter((region) => region.name !== regionName);
    if (nextRegions.length === this.regions.length) {
      return;
    }

    this.regionLoadGeneration += 1;
    this.regions = nextRegions;
    if (this.characterConfig) {
      this.characterConfig = {
        ...this.characterConfig,
        regions: (this.characterConfig.regions ?? []).filter((region) => region.name !== regionName),
      };
    }
    if (this.currentRegion === regionName) {
      this.currentRegion = null;
    }
    this.refreshLaterality();
    this.updateDOMControls();
    // A pending surface query must also see removals before it creates a marker.
    if (this.markers?.removeRegion) {
      this.markers.removeRegion(regionName);
    } else if (this.markersLoaded) {
      void this.loadMarkersForCurrentRegions();
    }
  }

  /**
   * Update an annotation region's configuration without reloading the character.
   * This updates the region's bones, meshes, or other properties and recalculates
   * the marker position automatically.
   *
   * @param regionName - Name of the region to update (e.g., 'face', 'left_eye')
   * @param update - Partial region config to merge with existing config
   */
  updateAnnotationRegion(regionName: string, update: Partial<AnnotationAnchoredRegion>): void {
    if (this.disposed) return;
    this.regionLoadGeneration += 1;
    console.log(`[CameraController] updateAnnotationRegion: ${regionName}`, update);

    // Find and update the region in our local state
    const regionIndex = this.regions.findIndex(r => r.name === regionName);
    if (regionIndex === -1) {
      const newRegion: AnnotationAnchoredRegion = { name: regionName, ...update };
      this.regions = [...this.regions, newRegion];
      if (this.characterConfig) {
        this.characterConfig = {
          ...this.characterConfig,
          regions: [...(this.characterConfig.regions ?? []), newRegion],
        };
      }
      this.refreshLaterality();
      this.updateDOMControls();
      if (this.markersLoaded) {
        if (this.markers?.updateRegion) {
          this.markers.updateRegion(regionName, newRegion);
        } else {
          void this.loadMarkersForCurrentRegions();
        }
      }
      console.log(`[CameraController] Region "${regionName}" added successfully`);
      return;
    }

    // Merge the update with existing region config
    const updatedRegion = { ...this.regions[regionIndex], ...update };
    this.regions[regionIndex] = updatedRegion;

    // Also update in characterConfig if present
    if (this.characterConfig?.regions) {
      const configIndex = this.characterConfig.regions.findIndex(r => r.name === regionName);
      if (configIndex !== -1) {
        this.characterConfig.regions[configIndex] = updatedRegion;
      }
    }

    this.refreshLaterality();

    // Update the marker system using the general updateRegion method
    if (this.markers && 'updateRegion' in this.markers) {
      (this.markers as DPthree3DMarkers).updateRegion(regionName, update);
    } else if (this.markers && 'updateRegionMeshes' in this.markers && update.meshes) {
      // Fallback to updateRegionMeshes if updateRegion not available
      (this.markers as DPthree3DMarkers).updateRegionMeshes(regionName, update.meshes);
    }

    this.updateDOMControls();
    console.log(`[CameraController] Region "${regionName}" updated successfully`);
  }

  /**
   * Get the current configuration for a specific region
   */
  getAnnotationRegion(regionName: string): AnnotationAnchoredRegion | undefined {
    return this.regions.find(r => r.name === regionName);
  }

  /**
   * Get all annotation regions
   */
  getAnnotationRegions(): AnnotationAnchoredRegion[] {
    return [...this.regions];
  }

  private buildRuntimeAnnotationRegionName(
    targetType: 'bone' | 'au',
    target: string,
    boneName: string,
    side?: RuntimeAnnotationSide,
  ): string {
    return [
      RUNTIME_ANNOTATION_REGION_PREFIX,
      targetType,
      ':',
      encodeRuntimeAnnotationSegment(target),
      ...(side ? [':', encodeRuntimeAnnotationSegment(side)] : []),
      ':bone:',
      encodeRuntimeAnnotationSegment(boneName),
    ].join('');
  }

  private buildRuntimeBoneAnnotationRegion(
    targetType: 'bone' | 'au',
    target: string,
    boneName: string,
    options: RuntimeAnnotationOptions,
    side?: RuntimeAnnotationSide,
  ): AnnotationAnchoredRegion {
    const regionName = this.buildRuntimeAnnotationRegionName(targetType, target, boneName, side);
    const defaultLabel = targetType === 'au' ? `AU ${target}: ${boneName}` : `Bone: ${boneName}`;
    const style = buildRuntimeAnnotationStyle(options);

    return {
      name: regionName,
      label: options.label ?? defaultLabel,
      bones: [boneName],
      paddingFactor: options.paddingFactor ?? 0.8,
      cameraAngle: options.cameraAngle,
      markerAnchor: {
        type: 'bone',
        bones: [boneName],
        projectToSurface: options.projectToSurface,
      },
      focusTarget: {
        type: 'bone',
        bones: [boneName],
        paddingFactor: options.paddingFactor ?? 0.8,
        cameraAngle: options.cameraAngle,
      },
      ...(style ? { style } : {}),
      runtimeAnnotation: {
        targetType,
        target,
        boneName,
        ...(side ? { side } : {}),
      },
    };
  }

  private buildRuntimeMeshAnnotationRegionName(
    targetType: 'bone' | 'au',
    target: string,
    meshName: string,
    side?: RuntimeAnnotationSide,
  ): string {
    return [
      RUNTIME_ANNOTATION_REGION_PREFIX,
      targetType,
      ':',
      encodeRuntimeAnnotationSegment(target),
      ...(side ? [':', encodeRuntimeAnnotationSegment(side)] : []),
      ':mesh:',
      encodeRuntimeAnnotationSegment(meshName),
    ].join('');
  }

  private buildRuntimeMeshAnnotationRegion(
    targetType: 'bone' | 'au',
    target: string,
    meshName: string,
    morphNames: string[],
    options: RuntimeAnnotationOptions,
    side?: RuntimeAnnotationSide,
  ): AnnotationAnchoredRegion {
    const regionName = this.buildRuntimeMeshAnnotationRegionName(targetType, target, meshName, side);
    const defaultLabel = targetType === 'au' ? `AU ${target}: ${meshName}` : `Mesh: ${meshName}`;
    const style = buildRuntimeAnnotationStyle(options);

    return {
      name: regionName,
      label: options.label ?? defaultLabel,
      meshes: [meshName],
      paddingFactor: options.paddingFactor ?? 0.8,
      cameraAngle: options.cameraAngle,
      markerAnchor: {
        type: 'mesh',
        meshes: [meshName],
        projectToSurface: options.projectToSurface,
      },
      focusTarget: {
        type: 'mesh',
        meshes: [meshName],
        paddingFactor: options.paddingFactor ?? 0.8,
        cameraAngle: options.cameraAngle,
      },
      ...(style ? { style } : {}),
      runtimeAnnotation: {
        targetType,
        target,
        meshName,
        morphNames,
        ...(side ? { side } : {}),
      },
    };
  }

  private upsertRuntimeBoneAnnotationRegion(
    targetType: 'bone' | 'au',
    target: string,
    boneName: string,
    options: RuntimeAnnotationOptions,
    side?: RuntimeAnnotationSide,
  ): RuntimeAnnotationRegionSummary {
    const region = this.buildRuntimeBoneAnnotationRegion(targetType, target, boneName, options, side);
    this.runtimeAnnotationRegionNames.add(region.name);
    const existingRegion = this.getAnnotationRegion(region.name);
    if (
      !existingRegion ||
      buildRuntimeAnnotationRegionSignature(existingRegion) !== buildRuntimeAnnotationRegionSignature(region)
    ) {
      this.updateAnnotationRegion(region.name, region);
    }

    return {
      name: region.name,
      label: getRuntimeAnnotationRegionLabel(region),
      targetType,
      target,
      bones: [boneName],
      ...(side ? { side } : {}),
    };
  }

  private upsertRuntimeMeshAnnotationRegion(
    targetType: 'bone' | 'au',
    target: string,
    meshName: string,
    morphNames: string[],
    options: RuntimeAnnotationOptions,
    side?: RuntimeAnnotationSide,
  ): RuntimeAnnotationRegionSummary {
    const region = this.buildRuntimeMeshAnnotationRegion(targetType, target, meshName, morphNames, options, side);
    this.runtimeAnnotationRegionNames.add(region.name);
    const existingRegion = this.getAnnotationRegion(region.name);
    if (
      !existingRegion ||
      buildRuntimeAnnotationRegionSignature(existingRegion) !== buildRuntimeAnnotationRegionSignature(region)
    ) {
      this.updateAnnotationRegion(region.name, region);
    }

    return {
      name: region.name,
      label: getRuntimeAnnotationRegionLabel(region),
      targetType,
      target,
      bones: [],
      meshes: [meshName],
      morphs: [...morphNames],
      ...(side ? { side } : {}),
    };
  }

  private clearRuntimeAnnotationsForTarget(
    targetType: 'bone' | 'au',
    target: string,
    keepRegionNames = new Set<string>(),
  ): string[] {
    const removed: string[] = [];

    for (const regionName of Array.from(this.runtimeAnnotationRegionNames)) {
      if (keepRegionNames.has(regionName)) continue;

      const region = this.getAnnotationRegion(regionName);
      const runtimeAnnotation = region?.runtimeAnnotation;
      if (
        runtimeAnnotation?.targetType === targetType
        && runtimeAnnotation.target === target
      ) {
        this.removeAnnotationRegion(regionName);
        removed.push(regionName);
      }
    }

    return removed;
  }

  private clearRuntimeAnnotationsExcept(keepRegionNames: Set<string>): string[] {
    const removed: string[] = [];

    for (const regionName of Array.from(this.runtimeAnnotationRegionNames)) {
      if (keepRegionNames.has(regionName)) continue;

      this.removeAnnotationRegion(regionName);
      removed.push(regionName);
    }

    return removed;
  }

  /**
   * Show a temporary annotation marker for a bone. Runtime annotations are
   * ordinary regions with explicit bone marker/focus anchors, tracked separately
   * so they can be cleared without modifying saved character annotations.
   */
  showRuntimeBoneAnnotation(
    boneName: string,
    options: RuntimeAnnotationOptions = {},
  ): RuntimeAnnotationRegionSummary {
    const normalizedBoneName = normalizeRuntimeAnnotationText(boneName);
    if (!normalizedBoneName) {
      throw new Error('Bone name is required');
    }

    const summary = this.upsertRuntimeBoneAnnotationRegion(
      'bone',
      normalizedBoneName,
      normalizedBoneName,
      options,
    );
    this.setMarkersVisible(true);
    return summary;
  }

  /**
   * Show temporary annotation markers for every bone binding used by an AU.
   * The optional profile override lets remote-control callers use the active
   * Embody engine profile, while normal controller consumers can rely on the
   * loaded character config.
   */
  showRuntimeAUAnnotations(
    auId: string | number,
    profileOverride?: unknown,
    options: RuntimeAnnotationOptions = {},
    morphTargetsByMesh?: unknown,
  ): RuntimeAnnotationRegionSummary[] {
    const normalizedAuId = normalizeRuntimeAnnotationText(auId);
    if (!normalizedAuId) {
      throw new Error('AU id is required');
    }

    const profileCandidates = getRuntimeAnnotationProfileCandidates(this.characterConfig, profileOverride);
    const targetSide = options.targetSide;
    const boneTargets = resolveRuntimeAnnotationAUBoneTargets(
      normalizedAuId,
      profileCandidates,
      targetSide,
    );
    const morphSelection = resolveRuntimeAnnotationAUMorphSelection(normalizedAuId, profileCandidates, targetSide);
    const meshTargets = resolveRuntimeAnnotationMorphMeshes(
      morphSelection.morphNames,
      morphTargetsByMesh,
      morphSelection.side,
    );

    if (boneTargets.length === 0 && meshTargets.length === 0) {
      if (morphSelection.morphNames.length > 0) {
        throw new Error(`AU ${normalizedAuId} has morph bindings but no matching morph target meshes to annotate`);
      }
      throw new Error(`AU ${normalizedAuId} has no bone or morph bindings to annotate`);
    }

    const bones = boneTargets.map((target) => target.boneName);
    const limitedTargets = limitRuntimeAnnotationTargets(bones, meshTargets, options);

    const desiredRegionNames = new Set<string>();
    for (const boneName of limitedTargets.bones) {
      const boneTarget = boneTargets.find((target) => target.boneName === boneName);
      desiredRegionNames.add(this.buildRuntimeAnnotationRegionName(
        'au',
        normalizedAuId,
        boneName,
        targetSide ? boneTarget?.side ?? targetSide : undefined,
      ));
    }
    for (const meshTarget of limitedTargets.meshTargets) {
      desiredRegionNames.add(this.buildRuntimeMeshAnnotationRegionName(
        'au',
        normalizedAuId,
        meshTarget.meshName,
        meshTarget.side,
      ));
    }

    if (options.replaceExisting) {
      this.clearRuntimeAnnotationsExcept(desiredRegionNames);
    } else if (targetSide) {
      this.clearRuntimeAnnotationsForTarget('au', normalizedAuId, desiredRegionNames);
    }

    const boneSummaries = limitedTargets.bones.map((boneName) => {
      const boneTarget = boneTargets.find((target) => target.boneName === boneName);
      return this.upsertRuntimeBoneAnnotationRegion(
        'au',
        normalizedAuId,
        boneName,
        options.label
          ? { ...options, label: `${options.label}: ${boneName}` }
          : options,
        targetSide ? boneTarget?.side ?? targetSide : undefined,
      );
    });
    const meshSummaries = limitedTargets.meshTargets.map(({ meshName, morphNames: targetMorphNames, side }) =>
      this.upsertRuntimeMeshAnnotationRegion(
        'au',
        normalizedAuId,
        meshName,
        targetMorphNames,
        options.label
          ? { ...options, label: `${options.label}: ${meshName}` }
          : options,
        side,
      )
    );
    const summaries = [...boneSummaries, ...meshSummaries];
    this.setMarkersVisible(true);
    return summaries;
  }

  /**
   * Remove all temporary runtime annotations created through the AU/bone API.
   */
  clearRuntimeAnnotations(): string[] {
    const removed = Array.from(this.runtimeAnnotationRegionNames);
    for (const regionName of removed) {
      this.removeAnnotationRegion(regionName);
    }
    return removed;
  }

  // ====== DOM CONTROLS ======

  /**
   * Show/hide built-in DOM controls
   */
  setDOMControlsVisible(visible: boolean): void {
    this.domControls?.setVisible(visible);
  }

  /**
   * Update DOM controls to reflect current regions
   */
  updateDOMControls(): void {
    if (!this.domControls) return;
    // AU slider previews create temporary runtime:annotation:* regions; keep
    // those out of the View dropdown so option text cannot widen the control.
    this.domControls.updateRegions(
      filterCameraViewRegions(this.getAnnotationRegions()),
      this.currentRegion ?? undefined,
    );
    this.domControls.setMarkersVisible(this.markersVisible);
  }

  // ====== CALLBACKS ======

  /**
   * Register callback for region changes
   */
  onRegionChange(callback: RegionChangeCallback): () => void {
    this.onRegionChangeCallbacks.push(callback);
    return () => {
      const index = this.onRegionChangeCallbacks.indexOf(callback);
      if (index > -1) this.onRegionChangeCallbacks.splice(index, 1);
    };
  }

  // ====== LIFECYCLE ======

  /**
   * Update loop - call in animation frame (from render loop)
   * This drives camera animations and marker updates
   */
  update(): void {
    if (this.disposed) return;
    if (this.pendingAnimation) {
      const animation = this.pendingAnimation;
      const sample = animation.runtime.sample(performance.now() - animation.startTime);
      this.applyCameraPose(sample);
      if (sample.done) {
        this.pendingAnimation = null;
        animation.runtime.dispose();
        animation.resolve();
      }
    }

    this.controls.update();
    this.markers?.update();
  }

  /**
   * Cleanup and dispose
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.regionLoadGeneration += 1;
    this.cameraRequestGeneration += 1;

    // Stop render loop if we're managing it
    this.stopRenderLoop();

    // Clean up resize handling
    this.cleanupResizeHandling();

    this.cancelCameraAnimation();

    // Dispose DOM controls
    this.domControls?.dispose();
    this.domControls = null;

    // Dispose markers
    this.markers?.dispose();
    this.markers = null;

    // Dispose OrbitControls
    this.controls.dispose();

    // Clear callbacks
    this.onRegionChangeCallbacks = [];
  }

  // ====== PRIVATE METHODS ======

  private initDOMControls(): void {
    this.domControls = new CameraDOMControls({
      container: this.controlsContainer,
      regions: filterCameraViewRegions(this.getAnnotationRegions()),
      currentRegion: this.currentRegion ?? undefined,
      markersVisible: this.markersVisible,
      onRegionSelect: this.selectRegion,
      onMarkersVisibleChange: (visible) => this.setMarkersVisible(visible),
    });
  }

  private notifyRegionChange(name: string): void {
    this.onRegionChangeCallbacks.forEach((cb) => cb(name));
    this.domControls?.setCurrentRegion(name);
    this.markers?.setCurrentRegion(name);
  }

  /**
   * Resolve region definition to actual Object3D instances
   */
  private resolveRegionObjects(region: Region): THREE.Object3D[] {
    if (!this.model) return [];

    const objects: THREE.Object3D[] = [];

    // Handle special '*' case for all objects - collect all meshes
    if (region.objects?.includes('*')) {
      const meshes: THREE.Object3D[] = [];
      this.model.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          meshes.push(obj);
        }
      });
      return meshes.length > 0 ? meshes : [this.model];
    }

    // Find bones - resolve semantic names to actual GLB names first
    if (region.bones) {
      const resolvedBoneNames = resolveBoneNames(region.bones, boneResolutionProfile(this.characterConfig));
      objects.push(...this.findObjectsByNames(resolvedBoneNames, 'Bone'));
    }

    // Find meshes
    if (region.meshes) {
      objects.push(...this.findObjectsByNames(region.meshes, 'Mesh'));
    }

    // Find any objects
    if (region.objects) {
      objects.push(...this.findObjectsByNames(region.objects));
    }

    return objects;
  }

  /**
   * Find objects by name with optional type filter.
   * Uses fuzzy matching to handle bone names with numeric suffixes
   * (e.g., "CC_Base_Head_038" matches "CC_Base_Head").
   */
  private findObjectsByNames(names: string[], type?: string): THREE.Object3D[] {
    if (!this.model) return [];

    const found: THREE.Object3D[] = [];
    const nameSet = new Set(names);

    this.model.traverse((obj) => {
      // Exact match first
      if (nameSet.has(obj.name)) {
        if (!type || obj.type === type) {
          found.push(obj);
        }
        return;
      }

      // Fuzzy match - check if obj.name starts with any target + numeric suffix
      for (const target of names) {
        if (fuzzyNameMatch(obj.name, target, this.characterConfig?.suffixPattern)) {
          if (!type || obj.type === type) {
            found.push(obj);
          }
          break;
        }
      }
    });

    return found;
  }

  /**
   * Get bounding box of vertices influenced by a bone from skinned meshes
   * This finds the actual geometry size around a bone for proper framing
   *
   * For skinned meshes, we need to compute the actual skinned vertex positions,
   * not just the bind pose positions.
   */
  private getBoneInfluencedBoundingBox(bone: THREE.Bone): THREE.Box3 | null {
    if (!this.model) return null;

    const box = new THREE.Box3();

    // Find the bone index in any skeleton
    let boneIndex = -1;
    let skeleton: THREE.Skeleton | null = null;

    this.model.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh;
      if (mesh.isSkinnedMesh && mesh.skeleton) {
        const idx = mesh.skeleton.bones.indexOf(bone);
        if (idx !== -1) {
          boneIndex = idx;
          skeleton = mesh.skeleton;
        }
      }
    });

    if (boneIndex === -1 || !skeleton) {
      return null;
    }

    // Find all skinned meshes and collect vertices influenced by this bone
    const tempVertex = new THREE.Vector3();
    const skinned = new THREE.Vector3();
    const tempMatrix = new THREE.Matrix4();

    this.model.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || mesh.skeleton !== skeleton) return;

      // Ensure bone matrices are up to date
      mesh.skeleton.update();

      const geometry = mesh.geometry;
      const positionAttr = geometry.getAttribute('position');
      const skinIndexAttr = geometry.getAttribute('skinIndex');
      const skinWeightAttr = geometry.getAttribute('skinWeight');

      if (!positionAttr || !skinIndexAttr || !skinWeightAttr) return;

      // Get the bind matrix inverse for skinning calculation
      const bindMatrixInverse = mesh.bindMatrixInverse;

      // Check each vertex
      for (let i = 0; i < positionAttr.count; i++) {
        // Check if this vertex is influenced by our bone (weight > 0.1)
        let isInfluenced = false;
        for (let j = 0; j < 4; j++) {
          const skinIdx = skinIndexAttr.getComponent(i, j);
          const weight = skinWeightAttr.getComponent(i, j);
          if (skinIdx === boneIndex && weight > 0.1) {
            isInfluenced = true;
            break;
          }
        }

        if (isInfluenced) {
          // Get the vertex position in local space
          tempVertex.fromBufferAttribute(positionAttr, i);

          // Apply skinning transformation
          // skinned = sum(weight_i * boneMatrix_i * bindMatrixInverse * vertex)
          skinned.set(0, 0, 0);

          for (let j = 0; j < 4; j++) {
            const skinIdx = skinIndexAttr.getComponent(i, j);
            const weight = skinWeightAttr.getComponent(i, j);

            if (weight > 0) {
              // Get bone matrix (already includes world transform)
              const boneMatrix = mesh.skeleton.boneMatrices;
              tempMatrix.fromArray(boneMatrix, skinIdx * 16);

              // Transform vertex: boneMatrix * bindMatrixInverse * vertex
              const transformed = tempVertex.clone();
              transformed.applyMatrix4(bindMatrixInverse);
              transformed.applyMatrix4(tempMatrix);
              transformed.multiplyScalar(weight);

              skinned.add(transformed);
            }
          }

          // Apply mesh world matrix to get final world position
          skinned.applyMatrix4(mesh.matrixWorld);
          box.expandByPoint(skinned);
        }
      }
    });

    return box.isEmpty() ? null : box;
  }

  /**
   * Calculate optimal camera position to frame objects
   * @param objects - Objects to focus on
   * @param overridePadding - Optional padding factor override
   * @param cameraAngle - Camera angle in degrees around Y axis (0 = front, 180 = back)
   */
  private calculateFocusPosition(
    objects: THREE.Object3D[],
    overridePadding?: number,
    cameraAngle?: number,
    angleSpace: 'model' | 'world' = 'model'
  ): FocusPosition {
    // Force update world matrices on entire scene before computing bounding box
    this.scene.updateMatrixWorld(true);

    // Compute combined bounding box
    const box = new THREE.Box3();

    for (const obj of objects) {
      // For bones, find the geometry influenced by this bone from skinned meshes
      if (obj.type === 'Bone') {
        const bone = obj as THREE.Bone;
        const worldPos = new THREE.Vector3();
        bone.getWorldPosition(worldPos);

        // Find skinned meshes and get vertices influenced by this bone
        const boneBox = this.getBoneInfluencedBoundingBox(bone);
        if (boneBox && !boneBox.isEmpty()) {
          box.union(boneBox);
        } else {
          // Fallback: just use the bone position
          box.expandByPoint(worldPos);
        }
      } else {
        // For meshes and other objects, use expandByObject
        const objBox = new THREE.Box3().setFromObject(obj);
        if (!objBox.isEmpty()) {
          box.union(objBox);
        }
      }
    }

    // Explicit front views need no model-wide clearance bounds.
    const modelBox = this.model && cameraAngle !== 0
      ? new THREE.Box3().setFromObject(this.model)
      : null;
    return toFocusPosition(requireAnnotationCameraCore().solveFocusFraming({
      focusBounds: box.isEmpty() ? undefined : {
        center: box.getCenter(new THREE.Vector3()),
        size: box.getSize(new THREE.Vector3()),
      },
      modelBounds: modelBox && !modelBox.isEmpty() ? {
        center: modelBox.getCenter(new THREE.Vector3()),
        size: modelBox.getSize(new THREE.Vector3()),
      } : undefined,
      modelQuaternion: this.model?.getWorldQuaternion(new THREE.Quaternion()),
      fovDegrees: this.camera.fov,
      aspect: this.camera.aspect,
      minDistance: this.config.minDistance,
      closeUpPaddingFactor: this.config.closeUpPaddingFactor,
      zoomPaddingFactor: this.config.zoomPaddingFactor,
      fullBodyPaddingFactor: this.config.fullBodyPaddingFactor,
      overridePadding,
      cameraAngle,
      angleSpace,
    }));
  }

  private calculatePointFocusPosition(
    target: THREE.Vector3,
    overridePadding?: number,
    cameraAngle?: number,
  ): FocusPosition {
    const pointSize = this.resolvePointFocusSize();
    const focusProxy = new THREE.Mesh(
      new THREE.BoxGeometry(pointSize, pointSize, pointSize)
    );
    focusProxy.position.copy(target);
    focusProxy.updateMatrixWorld(true);

    const focusPosition = this.calculateFocusPosition([focusProxy], overridePadding, cameraAngle);
    focusProxy.geometry.dispose();
    return focusPosition;
  }

  private resolvePointFocusSize(): number {
    if (!this.model) {
      return 0.1;
    }

    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) {
      return 0.1;
    }

    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDimension = Math.max(size.x, size.y, size.z);
    return Math.max(maxDimension * 0.04, 0.02);
  }

  private getFallbackFocusPosition(): FocusPosition {
    return {
      position: new THREE.Vector3(0, 0.8, 2.5),
      target: new THREE.Vector3(0, 0.8, 0),
      distance: 2.5,
    };
  }

  private isFullBodyRegion(region: Region): boolean {
    const normalizedName = region.name.trim().toLowerCase().replace(/\s+/g, '_');
    return normalizedName === 'full_body'
      || normalizedName === 'fullbody'
      || region.objects?.includes('*') === true;
  }

  private isLeftEyeRegion(region: Region): boolean {
    const normalizedName = region.name.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return normalizedName === 'left_eye'
      || normalizedName === 'lefteye'
      || normalizedName === 'eye_l'
      || normalizedName === 'l_eye'
      || (normalizedName.includes('left') && normalizedName.includes('eye'));
  }

  private findIntroLeftEyeRegion(): Region | undefined {
    return this.regions.find((region) => this.isLeftEyeRegion(region));
  }

  private resolveIntroLeftEyePadding(region: Region): number {
    const requestedPadding = region.paddingFactor ?? this.config.closeUpPaddingFactor;
    return Math.min(requestedPadding * INTRO_LEFT_EYE_PADDING_SCALE, INTRO_LEFT_EYE_PADDING_CAP);
  }

  private calculateIntroLeftEyeFocusPosition(region: Region): FocusPosition | null {
    const objects = this.resolveRegionObjects(region);
    if (objects.length === 0) {
      return null;
    }

    const focusPos = this.calculateFocusPosition(
      objects,
      this.resolveIntroLeftEyePadding(region),
      resolveRegionCameraAngle(region, this.laterality)
    );

    if (region.cameraOffset) {
      if (region.cameraOffset.x) focusPos.position.x += region.cameraOffset.x;
      if (region.cameraOffset.y) focusPos.position.y += region.cameraOffset.y;
      if (region.cameraOffset.z) focusPos.position.z += region.cameraOffset.z;
    }

    return this.applyIntroLeftEyeCompositionBias(focusPos);
  }

  private applyIntroLeftEyeCompositionBias(focusPos: FocusPosition): FocusPosition {
    if (!this.model) {
      return focusPos;
    }

    const modelBox = new THREE.Box3().setFromObject(this.model);
    if (modelBox.isEmpty()) {
      return focusPos;
    }

    const modelSize = new THREE.Vector3();
    modelBox.getSize(modelSize);
    const verticalBias = Math.max(
      modelSize.y * INTRO_LEFT_EYE_VERTICAL_BIAS_RATIO,
      INTRO_LEFT_EYE_MIN_VERTICAL_BIAS
    );

    const position = focusPos.position.clone();
    const target = focusPos.target.clone();
    position.y -= verticalBias;
    target.y -= verticalBias;

    return {
      position,
      target,
      distance: position.distanceTo(target),
    };
  }

  private calculateFullBodyFocusPosition(
    overridePadding?: number,
    cameraAngle?: number,
    angleSpace: 'model' | 'world' = 'model'
  ): FocusPosition {
    if (!this.model) return this.getFallbackFocusPosition();

    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model);
    if (box.isEmpty()) return this.getFallbackFocusPosition();

    return toFocusPosition(requireAnnotationCameraCore().solveFullBodyFraming({
      boxMin: box.min,
      boxMax: box.max,
      modelQuaternion: this.model.getWorldQuaternion(new THREE.Quaternion()),
      fovDegrees: this.camera.fov,
      aspect: this.camera.aspect,
      minDistance: this.config.minDistance,
      fullBodyPaddingFactor: this.config.fullBodyPaddingFactor,
      overridePadding,
      cameraAngle,
      angleSpace,
    }));
  }

  private refreshLaterality(): void {
    this.laterality = detectAnnotationLaterality(this.model, this.regions, boneResolutionProfile(this.characterConfig));
  }

  /** Resolver and paint continuations belong to one model/configuration load. */
  private isRegionLoadCurrent(request: number, model: THREE.Object3D | null): boolean {
    return !this.disposed && request === this.regionLoadGeneration && model === this.model;
  }

  /** Await Wasm once per request and abandon requests superseded during initialization. */
  private async beginCameraRequest(): Promise<number | null> {
    const request = ++this.cameraRequestGeneration;
    this.cancelCameraAnimation();
    if (this.disposed) return null;
    await getAnnotationCameraCore();
    return this.isCameraRequestCurrent(request) ? request : null;
  }

  private isCameraRequestCurrent(request: number): boolean {
    return !this.disposed && request === this.cameraRequestGeneration;
  }

  private cancelCameraAnimation(): void {
    this.timerAnimationFallbackToken += 1;
    const animation = this.pendingAnimation;
    this.pendingAnimation = null;
    if (animation) {
      animation.runtime.dispose();
      animation.resolve();
    }
  }

  private applyCameraPose(pose: CameraPose): void {
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.controls.target.set(pose.target.x, pose.target.y, pose.target.z);
  }

  private runCameraAnimation(runtime: RustCameraAnimation): Promise<void> {
    this.cancelCameraAnimation();
    const initial = runtime.sample(0);
    this.applyCameraPose(initial);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    if (initial.done) {
      runtime.dispose();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.pendingAnimation = { startTime: performance.now(), runtime, resolve };
      this.scheduleTimerAnimationFallback(() => this.pendingAnimation !== null);
    });
  }

  /** Sample the shared Rust flight from update(), alongside the renderer. */
  private animateCamera(
    targetPosition: THREE.Vector3,
    targetLookAt: THREE.Vector3,
    duration: number
  ): Promise<void> {
    return this.runCameraAnimation(requireAnnotationCameraCore().createCameraFlight(
      this.camera.position,
      this.controls.target,
      targetPosition,
      targetLookAt,
      duration,
    ));
  }
}
