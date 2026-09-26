import { boneResolutionProfile } from './boneResolutionProfile';
import {
  detectAnnotationLaterality,
  fuzzyNameMatch,
  getDefaultAnnotationLaterality,
  getModelLocalOrbitAngle,
  getSemanticHorizontalSign,
  getSemanticHorizontalSignForSide,
  getWorldDirectionForCameraAngle,
  resolveBoneNames,
  resolveFaceCenter,
  resolveRegionCameraAngle,
  resolveRegionVisibilityCameraAngle,
  toWorldDirection,
  type AnnotationLaterality,
  type RustAnnotationCameraCore,
} from './adapter';
import * as THREE from 'three';
import type {
  Region,
  CharacterConfig,
  MarkerStyleOverrides,
  LineConfig,
  LineStyle,
  LineCurve,
  NamedDirection,
  ExpandAnimation,
  ExpandedRegionState,
  MarkerGroup,
  FallbackConfig,
  AnnotationAnchoredRegion,
} from './types';
import { intersectMeshesInSlices } from './markerSurfaceRaycast';
import { waitForCharacterLoadPaint } from './loadFrame';
import { AnimationFrameTaskScheduler } from './animationFrameTaskScheduler';
import { getAnnotationCameraCore, requireAnnotationCameraCore } from './annotationCameraCore';
import {
  resolveMarkerAnchorRegion,
  shouldProjectMarkerAnchorToSurface,
  shouldUseFaceCenterForMarkerAnchor,
} from './annotationAnchorModel';
import {
  getRuntimeAUMorphAnchorPoint,
  getRuntimeAnnotationSide,
  getRuntimeAUMeshSideOffset,
} from './runtimeAnnotationSidePreview';

interface MarkerConfig {
  markerRadius?: number;
  markerColor?: number;
  lineColor?: number;
  lineLength?: number;
  labelColor?: string;
  labelBackground?: string;
  labelFontSize?: number;
  labelScale?: number;
}

const DEFAULT_CONFIG: Required<MarkerConfig> = {
  markerRadius: 0.008, // Smaller, more professional dots
  markerColor: 0x4299e1,
  lineColor: 0x4299e1,
  lineLength: 0.5,
  labelColor: '#ffffff',
  labelBackground: 'rgba(0, 0, 0, 0.75)',
  labelFontSize: 32,
  labelScale: 0.04,
};

// Reference model height for scaling (human character is ~1.8 units tall)
const REFERENCE_MODEL_HEIGHT = 1.8;

// Zoom threshold for scaling markers (relative to model height)
// When camera is closer than this ratio of model height, markers shrink
const ZOOM_THRESHOLD_RATIO = 0.8;
const ZOOMED_IN_SPHERE_SCALE = 0.25; // Spheres get much smaller (25%) when zoomed in
const ZOOMED_IN_LABEL_SCALE = 0.85; // Labels stay readable - only slightly smaller
const ZOOMED_IN_LINE_SCALE = 0.3; // Lines get much shorter when zoomed in

const VISIBILITY_ANIMATION_DURATION = 220;
const POSITION_EPSILON_SQUARED = 1e-8;
const GROUP_VISIBILITY_ANIMATION_KEY = 'marker-group';

function waitForNextMarkerFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }

    globalThis.setTimeout(resolve, 0);
  });
}

type MarkerVisibilityAnimationState = {
  arrow?: { object: THREE.Mesh; opacity: number };
  label?: { object: THREE.Sprite; opacity: number; scale: THREE.Vector3 };
  line?: { object: THREE.Line; opacity: number };
  sphere?: { object: THREE.Mesh; opacity: number };
};

export function shouldShow3DMarker(params: {
  name: string;
  hiddenChildren: Set<string>;
  soloedMarker: string | null;
  markerAngle?: number;
  currentCameraAngle?: number;
}): boolean {
  return requireAnnotationCameraCore().shouldShowMarker({
    hiddenChild: params.hiddenChildren.has(params.name),
    solo: params.soloedMarker === null
      ? 'none'
      : params.soloedMarker === params.name ? 'soloed' : 'other-soloed',
    markerAngle: params.markerAngle,
    currentCameraAngle: params.currentCameraAngle,
  });
}

function getAnnotationRegionLabel(region: Region): string | undefined {
  const label = (region as AnnotationAnchoredRegion).label;
  if (typeof label !== 'string') return undefined;
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isFiniteClipPoint(point: THREE.Vector4): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) &&
    Number.isFinite(point.z) && Number.isFinite(point.w);
}

export function resolveViewportConstrainedLineScale(params: {
  startClip: THREE.Vector4;
  endClip: THREE.Vector4;
  safeX: number;
  safeY: number;
  minLengthRatio?: number;
}): { visible: boolean; lineScale: number } {
  // Reject invalid projections before crossing the float32 Wasm boundary.
  if (!isFiniteClipPoint(params.endClip)) {
    return { visible: false, lineScale: 0 };
  }
  return requireAnnotationCameraCore().resolveViewportConstrainedLineScale({
    ...params,
    startClip: params.startClip.toArray(),
    endClip: params.endClip.toArray(),
  });
}

export function resolveViewportSafeBounds(params: {
  labelScaleX: number;
  labelScaleY: number;
  projectionXScale: number;
  projectionYScale: number;
  viewportWidth: number;
  viewportHeight: number;
  edgePaddingPx?: number;
}): { safeX: number; safeY: number } {
  return requireAnnotationCameraCore().resolveViewportSafeBounds(params);
}

/**
 * Pure 3D visual markers for annotations.
 *
 * SIMPLE RULE: Lines always point AWAY from model center.
 * - Horizontal: left annotations go left, right go right
 * - Vertical: high annotations go up, low go down
 */
export class DPthree3DMarkers {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private domElement: HTMLElement;
  private model: THREE.Object3D | null = null;
  private regions: Region[] = [];
  private currentRegion: string | null = null;
  private onSelect: (name: string) => void;
  private config: Required<MarkerConfig>;

  private markerGroup: THREE.Group;
  private markerMeshes: Map<string, THREE.Mesh> = new Map();
  private lineMeshes: Map<string, THREE.Line> = new Map();
  private lineEndpoints: Map<string, { start: THREE.Vector3; end: THREE.Vector3; direction: THREE.Vector3 }> = new Map();
  private labelSprites: Map<string, THREE.Sprite> = new Map();
  private labelScales: Map<string, { x: number; y: number }> = new Map();

  // Store the original line length (before zoom scaling) for each marker
  private originalLineLengths: Map<string, number> = new Map();
  // Store direct bone references and local offsets for efficient animation updates
  private boneRefs: Map<string, THREE.Object3D> = new Map();
  private localOffsets: Map<string, THREE.Vector3> = new Map(); // Offset in bone-local space

  // Model bounds - cached once when model is set
  private modelCenter = new THREE.Vector3();
  private modelSize = new THREE.Vector3();
  private modelMeshes: THREE.Mesh[] = [];
  private regionLoadHasFreshMatrices = false;

  // Zoom-based scaling state (only updates when crossing threshold)
  private isZoomedIn = false;
  private zoomThreshold = 1.0; // Calculated from model size
  private autoCollapseThreshold = 2.0; // Calculated from model size - collapse expanded regions when zoomed out
  private lastCameraDistance = -1; // Cache to avoid unnecessary checks
  private visibilityAnimationActive = false;
  private readonly visibilityAnimationScheduler = new AnimationFrameTaskScheduler();
  private visibilityAnimationStates: MarkerVisibilityAnimationState[] = [];
  private activeMarkerVisibilityAnimations = new Set<string>();
  private markerVisibilityAnimationStates: Map<string, MarkerVisibilityAnimationState> = new Map();
  private markerTargetVisibility: Map<string, boolean> = new Map();
  private markerAngleGateVisibility: Map<string, boolean> = new Map();
  private markerViewportVisibility: Map<string, boolean> = new Map();
  private hasCameraAngleUpdateSnapshot = false;
  private lastCameraAngleUpdatePosition = new THREE.Vector3();
  private lastCameraAngleUpdateQuaternion = new THREE.Quaternion();

  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private scratchClipStart = new THREE.Vector4();
  private scratchClipEnd = new THREE.Vector4();
  private readonly scratchClipStartValues = [0, 0, 0, 0];
  private readonly scratchClipEndValues = [0, 0, 0, 0];
  private scratchWorldEnd = new THREE.Vector3();
  private scratchConstrainedEnd = new THREE.Vector3();
  private tempSurfacePoint = new THREE.Vector3();
  private scratchArrowDirection = new THREE.Vector3();
  private scratchArrowQuaternion = new THREE.Quaternion();
  private arrowUp = new THREE.Vector3(0, 1, 0);

  // === CUSTOMIZATION STATE ===
  // Character-level defaults (from config)
  private charLineDefaults: LineConfig = {};
  private charMarkerDefaults: Partial<MarkerStyleOverrides> = {};

  // Resolved styles per region (cached for performance)
  private resolvedStyles: Map<string, Required<MarkerStyleOverrides>> = new Map();

  // Expanding anchors state
  private expandedRegions: Map<string, boolean> = new Map();
  private parentChildIndex: Map<string, string[]> = new Map(); // parent -> children
  private childParentIndex: Map<string, string> = new Map(); // child -> parent
  private hiddenChildren: Set<string> = new Set();

  // Solo mode
  private soloedMarker: string | null = null;

  // Fallback markers
  private markerGroups: MarkerGroup[] = [];
  private groupVisibility: Map<string, Set<string>> = new Map(); // groupId -> visible region names

  // Arrow head meshes (for styled lines)
  private arrowMeshes: Map<string, THREE.Mesh> = new Map();

  // Character config for bone name resolution
  private characterConfig: CharacterConfig | null = null;
  private laterality: AnnotationLaterality = getDefaultAnnotationLaterality();
  private regionLoadGeneration = 0;

  constructor(inputConfig: {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    domElement: HTMLElement;
    onSelect: (name: string) => void;
    markerConfig?: MarkerConfig;
  }) {
    this.scene = inputConfig.scene;
    this.camera = inputConfig.camera;
    this.domElement = inputConfig.domElement;
    this.onSelect = inputConfig.onSelect;
    this.config = { ...DEFAULT_CONFIG, ...inputConfig.markerConfig };

    this.markerGroup = new THREE.Group();
    this.markerGroup.name = 'DPthree3DMarkers';
    this.scene.add(this.markerGroup);

    this.domElement.addEventListener('click', this.onClick);
  }

  setModel(model: THREE.Object3D): void {
    this.regionLoadGeneration += 1;
    this.regionLoadHasFreshMatrices = false;
    this.model = model;
    // Force update of world matrices before computing bounds
    model.updateMatrixWorld(true);
    this.modelMeshes = [];
    model.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) {
        this.modelMeshes.push(object as THREE.Mesh);
      }
    });
    // Cache model bounds
    const box = new THREE.Box3().setFromObject(model);
    box.getCenter(this.modelCenter);
    box.getSize(this.modelSize);

    // Calculate zoom threshold based on model height
    this.zoomThreshold = this.modelSize.y * ZOOM_THRESHOLD_RATIO;
    // Auto-collapse threshold is 2.5x the zoom threshold - when zoomed out this far, collapse all expanded regions
    this.autoCollapseThreshold = this.zoomThreshold * 2.5;
    this.lastCameraDistance = -1; // Reset to force recalculation
    this.isZoomedIn = false;
    this.hasCameraAngleUpdateSnapshot = false;
    this.refreshLaterality();
  }

  async loadRegions(config: CharacterConfig, options: { sliceSurfaceQueries?: boolean } = {}): Promise<void> {
    const loadGeneration = ++this.regionLoadGeneration;
    const loadModel = this.model;
    const annotationCameraCore = await getAnnotationCameraCore();
    if (loadGeneration !== this.regionLoadGeneration || this.model !== loadModel) {
      return;
    }

    console.log(`[3DMarkers] loadRegions: ${config.characterId}, ${(config.regions ?? []).length} regions, model loaded: ${!!this.model}`);
    this.clear();
    const activeLoadGeneration = this.regionLoadGeneration;
    const isCurrent = () => activeLoadGeneration === this.regionLoadGeneration && this.model === loadModel;
    this.regions = config.regions ?? [];
    this.characterConfig = config;
    this.model?.updateMatrixWorld(true);
    this.regionLoadHasFreshMatrices = true;
    this.refreshLaterality();

    // Store character-level defaults
    this.charLineDefaults = config.lineDefaults || {};
    this.charMarkerDefaults = config.markerDefaults || {};
    this.markerGroups = config.markerGroups || [];

    // Build parent/child index
    this.parentChildIndex.clear();
    this.childParentIndex.clear();
    this.hiddenChildren.clear();
    for (const region of (config.regions ?? [])) {
      if (region.children && region.children.length > 0) {
        this.parentChildIndex.set(region.name, region.children);
        for (const childName of region.children) {
          this.childParentIndex.set(childName, region.name);
          this.hiddenChildren.add(childName);
        }
      }
    }

    // Resolve and cache styles for each region
    this.resolvedStyles.clear();
    for (const region of (config.regions ?? [])) {
      this.resolvedStyles.set(region.name, this.resolveRegionStyle(region));
    }

    // Initialize group visibility tracking
    this.groupVisibility.clear();
    for (const group of this.markerGroups) {
      this.groupVisibility.set(group.groupId, new Set());
    }

    try {
      // Create markers (children start hidden if they have a parent)
      for (const [index, region] of (config.regions ?? []).entries()) {
        if (!isCurrent()) {
          return;
        }

        const hasParent = this.childParentIndex.has(region.name);
        // Only initial reveal has a stable pose across render opportunities.
        // Interactive rebuilds preserve their synchronous surface sampling.
        if (options.sliceSurfaceQueries) {
          await this.createMarkerInSlices(region, hasParent, () => isCurrent() && this.regions.includes(region));
        } else {
          this.createMarker(region, hasParent);
        }
        if (!isCurrent()) return;

        // Marker placement performs geometry raycasts and label rasterization.
        // Yield between regions so it cannot monopolize the frame that begins
        // or completes the character's intro camera transition.
        if (index < (config.regions ?? []).length - 1) {
          await waitForNextMarkerFrame();
        }
      }

      if (!isCurrent()) {
        return;
      }

      // After all markers are created, separate any that are too close together
      this.separateOverlappingMarkers(annotationCameraCore);

      console.log(`[3DMarkers] loadRegions complete. Created markers for:`, Array.from(this.markerMeshes.keys()));
      console.log(`[3DMarkers] lineEndpoints:`, Array.from(this.lineEndpoints.keys()));
      console.log(`[3DMarkers] resolvedStyles:`, Array.from(this.resolvedStyles.keys()));
    } finally {
      if (isCurrent()) {
        this.regionLoadHasFreshMatrices = false;
      }
    }
  }

  /**
   * Update a region's configuration and recreate its marker.
   * This is the general method for updating any region properties.
   *
   * @param regionName - Name of the region to update
   * @param update - Partial region config to merge with existing config
   */
  updateRegion(regionName: string, update: Partial<Region>): void {
    console.log(`[3DMarkers] updateRegion: ${regionName}`, update);

    // Find the region
    const regionIndex = this.regions.findIndex(r => r.name === regionName);
    if (regionIndex === -1) {
      const newRegion: Region = { name: regionName, ...update };
      this.regions = [...this.regions, newRegion];
      if (this.characterConfig) {
        this.characterConfig = {
          ...this.characterConfig,
          regions: [...(this.characterConfig.regions ?? []), newRegion],
        };
      }
      this.refreshLaterality();
      this.resolvedStyles.set(regionName, this.resolveRegionStyle(newRegion));
      const hasParent = this.childParentIndex.has(newRegion.name);
      this.createMarker(newRegion, hasParent);
      this.hasCameraAngleUpdateSnapshot = false;
      console.log(`[3DMarkers] Region "${regionName}" marker created`);
      return;
    }

    // Merge update with existing region config
    this.regions[regionIndex] = {
      ...this.regions[regionIndex],
      ...update,
    };

    // Also update characterConfig if it exists
    if (this.characterConfig?.regions) {
      const configRegionIndex = this.characterConfig.regions.findIndex(r => r.name === regionName);
      if (configRegionIndex !== -1) {
        this.characterConfig.regions[configRegionIndex] = {
          ...this.characterConfig.regions[configRegionIndex],
          ...update,
        };
      }
    }

    this.refreshLaterality();
    this.resolvedStyles.set(regionName, this.resolveRegionStyle(this.regions[regionIndex]));

    // Remove and recreate the marker
    this.removeMarkerComponents(regionName);

    // Recreate the marker with updated configuration
    const region = this.regions[regionIndex];
    const hasParent = this.childParentIndex.has(region.name);
    this.createMarker(region, hasParent);
    this.hasCameraAngleUpdateSnapshot = false;

    console.log(`[3DMarkers] Region "${regionName}" marker recreated with updated config`);
  }

  removeRegion(regionName: string): void {
    const regionIndex = this.regions.findIndex(r => r.name === regionName);
    if (regionIndex !== -1) {
      this.regions = this.regions.filter((region) => region.name !== regionName);
    }

    if (this.characterConfig?.regions) {
      this.characterConfig = {
        ...this.characterConfig,
        regions: this.characterConfig.regions.filter((region) => region.name !== regionName),
      };
    }

    this.resolvedStyles.delete(regionName);
    this.parentChildIndex.delete(regionName);
    this.childParentIndex.delete(regionName);
    this.hiddenChildren.delete(regionName);
    this.removeMarkerComponents(regionName);
    this.hasCameraAngleUpdateSnapshot = false;
  }

  /**
   * Remove all marker components for a region (marker, line, label, bone refs)
   */
  private removeMarkerComponents(regionName: string): void {
    // Remove old marker for this region (markers are in markerGroup, not scene)
    const oldMarker = this.markerMeshes.get(regionName);
    if (oldMarker) {
      this.markerGroup.remove(oldMarker);
      this.markerMeshes.delete(regionName);
    }

    // Remove old line mesh (lines are in markerGroup, not scene)
    const oldLine = this.lineMeshes.get(regionName);
    if (oldLine) {
      this.markerGroup.remove(oldLine);
      this.lineMeshes.delete(regionName);
    }

    // Remove old line endpoint data
    this.lineEndpoints.delete(regionName);
    this.originalLineLengths.delete(regionName);

    // Remove old label sprite (labels are in markerGroup, not scene)
    const oldLabel = this.labelSprites.get(regionName);
    if (oldLabel) {
      this.markerGroup.remove(oldLabel);
      this.labelSprites.delete(regionName);
      this.labelScales.delete(regionName);
    }

    // Remove old arrow if exists
    const oldArrow = this.arrowMeshes.get(regionName);
    if (oldArrow) {
      this.markerGroup.remove(oldArrow);
      this.arrowMeshes.delete(regionName);
    }

    // Remove old bone reference and offset
    this.boneRefs.delete(regionName);
    this.localOffsets.delete(regionName);
    this.markerTargetVisibility.delete(regionName);
    this.markerAngleGateVisibility.delete(regionName);
    this.markerViewportVisibility.delete(regionName);
  }

  updateRegionMeshes(regionName: string, meshNames: string[]): void {
    console.log(`[3DMarkers] updateRegionMeshes: ${regionName} -> ${meshNames.join(', ')}`);
    this.updateRegion(regionName, { meshes: meshNames });
  }

  /**
   * Reposition an existing marker to a new position.
   * This moves the marker, line, and label without recreating them.
   *
   * @param regionName - Name of the region to reposition
   * @param newPosition - New world position for the marker
   */
  repositionMarker(regionName: string, newPosition: THREE.Vector3): void {
    console.log(`[3DMarkers] repositionMarker: ${regionName} -> (${newPosition.x.toFixed(3)}, ${newPosition.y.toFixed(3)}, ${newPosition.z.toFixed(3)})`);

    const marker = this.markerMeshes.get(regionName);

    if (!marker) {
      console.warn(`[3DMarkers] repositionMarker: No marker found for "${regionName}"`);
      return;
    }

    marker.position.copy(newPosition);
    this.updateMarkerLineLayout(regionName);

    console.log(`[3DMarkers] Marker "${regionName}" repositioned`);
  }

  /**
   * Get the current position of a marker
   */
  getMarkerPosition(regionName: string): THREE.Vector3 | null {
    const marker = this.markerMeshes.get(regionName);
    return marker ? marker.position.clone() : null;
  }

  /**
   * Resolve the effective style for a region by merging:
   * global defaults -> character defaults -> region style
   */
  private resolveRegionStyle(region: Region): Required<MarkerStyleOverrides> {
    const defaults: Required<MarkerStyleOverrides> = {
      markerColor: this.config.markerColor,
      markerRadius: this.config.markerRadius,
      lineColor: this.config.lineColor,
      labelColor: this.config.labelColor,
      labelBackground: this.config.labelBackground,
      labelFontSize: this.config.labelFontSize,
      opacity: 1,
      lineDirection: 'radial', // Default: from model center
      line: {
        style: 'solid',
        curve: 'straight',
        arrowHead: false,
        thickness: 2,
        length: this.config.lineLength,
      },
    };

    // Merge character-level defaults
    const charDefaults = this.charMarkerDefaults;
    if (charDefaults.markerColor !== undefined) defaults.markerColor = charDefaults.markerColor;
    if (charDefaults.markerRadius !== undefined) defaults.markerRadius = charDefaults.markerRadius;
    if (charDefaults.lineColor !== undefined) defaults.lineColor = charDefaults.lineColor;
    if (charDefaults.labelColor !== undefined) defaults.labelColor = charDefaults.labelColor;
    if (charDefaults.labelBackground !== undefined) defaults.labelBackground = charDefaults.labelBackground;
    if (charDefaults.labelFontSize !== undefined) defaults.labelFontSize = charDefaults.labelFontSize;
    if (charDefaults.opacity !== undefined) defaults.opacity = charDefaults.opacity;
    if (charDefaults.lineDirection !== undefined) defaults.lineDirection = charDefaults.lineDirection;
    if (charDefaults.line) {
      defaults.line = { ...defaults.line, ...charDefaults.line };
    }

    // Merge character-level line defaults
    if (this.charLineDefaults.style !== undefined) defaults.line.style = this.charLineDefaults.style;
    if (this.charLineDefaults.curve !== undefined) defaults.line.curve = this.charLineDefaults.curve;
    if (this.charLineDefaults.arrowHead !== undefined) defaults.line.arrowHead = this.charLineDefaults.arrowHead;
    if (this.charLineDefaults.thickness !== undefined) defaults.line.thickness = this.charLineDefaults.thickness;
    if (this.charLineDefaults.length !== undefined) defaults.line.length = this.charLineDefaults.length;

    // Merge region-level style overrides
    const regionStyle = region.style || {};
    if (regionStyle.markerColor !== undefined) defaults.markerColor = regionStyle.markerColor;
    if (regionStyle.markerRadius !== undefined) defaults.markerRadius = regionStyle.markerRadius;
    if (regionStyle.lineColor !== undefined) defaults.lineColor = regionStyle.lineColor;
    if (regionStyle.labelColor !== undefined) defaults.labelColor = regionStyle.labelColor;
    if (regionStyle.labelBackground !== undefined) defaults.labelBackground = regionStyle.labelBackground;
    if (regionStyle.labelFontSize !== undefined) defaults.labelFontSize = regionStyle.labelFontSize;
    if (regionStyle.opacity !== undefined) defaults.opacity = regionStyle.opacity;
    if (regionStyle.lineDirection !== undefined) defaults.lineDirection = regionStyle.lineDirection;
    if (regionStyle.line) {
      defaults.line = { ...defaults.line, ...regionStyle.line };
    }

    // Leaf regions (no children) use dashed lines by default
    if (!region.children || region.children.length === 0) {
      defaults.line.style = 'dashed';
    }

    return defaults;
  }

  /**
   * Resolve a named direction or custom vector to a THREE.Vector3.
   * For 'camera' direction, returns direction from position toward current camera.
   */
  private resolveLineDirection(
    direction: NamedDirection | { x: number; y: number; z: number },
    position: THREE.Vector3
  ): THREE.Vector3 {
    if (typeof direction === 'object') {
      return new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
    }

    switch (direction) {
      case 'radial':
        return new THREE.Vector3().subVectors(position, this.modelCenter).normalize();
      case 'camera':
        return new THREE.Vector3().subVectors(this.camera.position, position).normalize();
      case 'up':
        return new THREE.Vector3(0, 1, 0);
      case 'down':
        return new THREE.Vector3(0, -1, 0);
      case 'left':
        return toWorldDirection(
          this.model,
          new THREE.Vector3(getSemanticHorizontalSignForSide('left', this.laterality), 0, 0)
        );
      case 'right':
        return toWorldDirection(
          this.model,
          new THREE.Vector3(getSemanticHorizontalSignForSide('right', this.laterality), 0, 0)
        );
      case 'forward':
        return toWorldDirection(this.model, new THREE.Vector3(0, 0, 1));
      case 'backward':
        return toWorldDirection(this.model, new THREE.Vector3(0, 0, -1));
      default:
        return toWorldDirection(this.model, new THREE.Vector3(0, 0, 1));
    }
  }

  /**
   * Create a bezier curve between two points.
   */
  private createBezierCurve(start: THREE.Vector3, end: THREE.Vector3, segments = 16): THREE.Vector3[] {
    const values = requireAnnotationCameraCore().sampleMarkerBezierCurve(start, end, segments);
    return this.unpackCurvePoints(values);
  }

  /**
   * Create an arc curve between two points.
   */
  private createArcCurve(start: THREE.Vector3, end: THREE.Vector3, segments = 16): THREE.Vector3[] {
    const values = requireAnnotationCameraCore().sampleMarkerArcCurve(start, end, segments);
    return this.unpackCurvePoints(values);
  }

  private unpackCurvePoints(values: Float32Array): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < values.length; i += 3) {
      points.push(new THREE.Vector3(values[i], values[i + 1], values[i + 2]));
    }
    return points;
  }

  /**
   * Create a styled line with support for dashed/dotted, curves, and arrow heads.
   */
  private createStyledLine(
    start: THREE.Vector3,
    end: THREE.Vector3,
    lineConfig: Required<LineConfig>,
    color: number,
    opacity: number,
    regionName: string
  ): THREE.Line {
    console.log(`[3DMarkers] createStyledLine: ${regionName}`, {
      style: lineConfig.style,
      curve: lineConfig.curve,
      color: color.toString(16),
      opacity,
    });

    // Get curve points based on curve type
    let points: THREE.Vector3[];
    switch (lineConfig.curve) {
      case 'bezier':
        points = this.createBezierCurve(start, end);
        break;
      case 'arc':
        points = this.createArcCurve(start, end);
        break;
      default:
        points = [start.clone(), end.clone()];
    }

    console.log(`[3DMarkers] createStyledLine: ${regionName} has ${points.length} points (curve: ${lineConfig.curve})`);

    const geometry = new THREE.BufferGeometry().setFromPoints(points);

    // Create material based on style
    let material: THREE.LineBasicMaterial | THREE.LineDashedMaterial;

    if (lineConfig.style === 'dashed' || lineConfig.style === 'dotted') {
      const dashSize = lineConfig.style === 'dotted' ? 0.005 : 0.02;
      const gapSize = lineConfig.style === 'dotted' ? 0.01 : 0.01;

      console.log(`[3DMarkers] createStyledLine: ${regionName} using LineDashedMaterial (dashSize=${dashSize}, gapSize=${gapSize})`);

      material = new THREE.LineDashedMaterial({
        color,
        transparent: true,
        opacity,
        dashSize,
        gapSize,
      });
    } else {
      console.log(`[3DMarkers] createStyledLine: ${regionName} using LineBasicMaterial`);
      material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity,
      });
    }

    const line = new THREE.Line(geometry, material);

    // Compute line distances for dashed materials
    if (lineConfig.style === 'dashed' || lineConfig.style === 'dotted') {
      line.computeLineDistances();
      const lineDistances = line.geometry.getAttribute('lineDistance');
      console.log(`[3DMarkers] createStyledLine: ${regionName} computed line distances, count=${lineDistances?.count}`);
    }

    // Create arrow head if requested
    if (lineConfig.arrowHead) {
      const lastPoint = points[points.length - 1];
      const secondLastPoint = points[points.length - 2];
      const arrowDirection = new THREE.Vector3()
        .subVectors(lastPoint, secondLastPoint)
        .normalize();

      const arrowMesh = this.createArrowHead(lastPoint, arrowDirection, color, opacity);
      arrowMesh.name = `arrow_${regionName}`;
      arrowMesh.userData.annotation = regionName;
      this.markerGroup.add(arrowMesh);
      this.arrowMeshes.set(regionName, arrowMesh);
    }

    return line;
  }

  /**
   * Create an arrow head cone mesh.
   */
  private createArrowHead(
    position: THREE.Vector3,
    direction: THREE.Vector3,
    color: number,
    opacity: number
  ): THREE.Mesh {
    const scale = this.modelSize.y / REFERENCE_MODEL_HEIGHT;
    const arrowLength = 0.02 * scale;
    const arrowRadius = 0.008 * scale;

    const geometry = new THREE.ConeGeometry(arrowRadius, arrowLength, 8);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);

    // Orient arrow to point along direction
    const up = new THREE.Vector3(0, 1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, direction);
    mesh.setRotationFromQuaternion(quaternion);

    return mesh;
  }

  setCurrentRegion(name: string | null): void {
    this.currentRegion = name;
    this.updateMarkerStyles();
  }

  /**
   * Create a marker for an annotation.
   *
   * Algorithm:
   * 1. Find annotation center from bones/meshes
   * 2. Determine best outward direction based on annotation type, cameraAngle, or style.lineDirection
   * 3. Raycast from outside toward annotation center to find surface point
   * 4. Line extends outward from surface with configured styling
   *
   */
  private resolveMarkerPlacement(region: Region) {
    if (!this.model) {
      console.warn(`[3DMarkers] createMarker: No model for region ${region.name}`);
      return null;
    }

    // Get resolved style for this region
    const style = this.resolvedStyles.get(region.name);
    if (!style) {
      console.warn(`[3DMarkers] createMarker: No style for region ${region.name}`);
      return null;
    }

    // Get annotation center and bounding box
    const result = this.getRegionCenterAndBox(region);
    if (!result) {
      console.warn(`[3DMarkers] createMarker: Could not get center/box for region ${region.name}`);
      return null;
    }

    const { center: annotationCenter, usedRuntimeMorphAnchor } = result;
    const visibilityCameraAngle = resolveRegionVisibilityCameraAngle(region, this.laterality);

    // Resolve the bone now; store it only after projection is still current.
    const primaryBone = this.findPrimaryBone(region);

    // Determine outward direction based on:
    // 1. Custom lineDirection in style (highest priority)
    // 2. Region's cameraAngle
    // 3. Semantic direction based on region name
    let outwardDir: THREE.Vector3;
    if (style.lineDirection && style.lineDirection !== 'radial') {
      // Use custom direction from style
      outwardDir = this.resolveLineDirection(style.lineDirection, annotationCenter);
    } else {
      // Fall back to existing semantic direction logic
      outwardDir = this.getOutwardDirection(region, annotationCenter);
    }

    const resolvedAnchor = resolveMarkerAnchorRegion(region);
    const anchorRegion = resolvedAnchor.region;

    // For mesh-only annotations (like eyes), place marker at the annotation center
    // These are typically computed positions (e.g., bone + offset) where raycasting doesn't help
    const isMeshOnly =
      anchorRegion.meshes &&
      anchorRegion.meshes.length > 0 &&
      !anchorRegion.bones &&
      !anchorRegion.objects;

    return {
      style, annotationCenter, outwardDir, primaryBone, visibilityCameraAngle,
      projectToSurface: !usedRuntimeMorphAnchor && shouldProjectMarkerAnchorToSurface(resolvedAnchor, !isMeshOnly),
    };
  }

  private createMarker(region: Region, startHidden = false): void {
    const placement = this.resolveMarkerPlacement(region);
    if (!placement) return;
    const surfacePoint = placement.projectToSurface
      ? this.findSurfacePoint(placement.annotationCenter, placement.outwardDir)
      : placement.annotationCenter.clone();
    this.renderMarker(region, startHidden, placement, surfacePoint);
  }

  private async createMarkerInSlices(region: Region, startHidden: boolean, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent()) return;
    const placement = this.resolveMarkerPlacement(region);
    if (!placement) return;
    const surfacePoint = placement.projectToSurface
      ? await this.findSurfacePointInSlices(placement.annotationCenter, placement.outwardDir, isCurrent)
      : placement.annotationCenter.clone();
    if (!surfacePoint || !isCurrent()) return;
    this.renderMarker(region, startHidden, placement, surfacePoint);
  }

  private renderMarker(
    region: Region,
    startHidden: boolean,
    placement: NonNullable<ReturnType<DPthree3DMarkers['resolveMarkerPlacement']>>,
    surfacePoint: THREE.Vector3,
  ): void {
    const { style, primaryBone, outwardDir, visibilityCameraAngle } = placement;
    if (primaryBone) this.boneRefs.set(region.name, primaryBone);

    // Scale relative to reference model height so fish and human look the same
    const modelHeight = this.modelSize.y;
    const scale = modelHeight / REFERENCE_MODEL_HEIGHT;
    const scaledRadius = style.markerRadius * scale;
    const lineLength = style.line.length ?? this.config.lineLength;
    const scaledLineLength = lineLength * scale;
    const opacity = style.opacity;

    // Store the offset in bone-local space for animation updates
    if (primaryBone) {
      // Convert surface point to bone-local coordinates
      const boneInverse = primaryBone.matrixWorld.clone().invert();
      const localSurfacePoint = surfacePoint.clone().applyMatrix4(boneInverse);
      this.localOffsets.set(region.name, localSurfacePoint);
    }

    // Create sphere at surface - use depth testing for natural occlusion
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(scaledRadius, 12, 12),
      new THREE.MeshBasicMaterial({
        color: style.markerColor,
        transparent: true,
        opacity: 0.95 * opacity,
      })
    );
    sphere.position.copy(surfacePoint);
    sphere.name = `marker_${region.name}`;
    sphere.userData.annotation = region.name;
    sphere.userData.cameraAngle = visibilityCameraAngle;
    sphere.userData.groupId = region.groupId;
    sphere.userData.isFallback = region.isFallback;
    sphere.visible = !startHidden && !region.isFallback; // Fallbacks start hidden
    this.markerGroup.add(sphere);
    this.markerMeshes.set(region.name, sphere);

    // Line end point: extend outward from surface
    const lineEnd = surfacePoint.clone().add(
      outwardDir.clone().multiplyScalar(scaledLineLength)
    );

    // Store line endpoints for zoom scaling
    this.lineEndpoints.set(region.name, {
      start: surfacePoint.clone(),
      end: lineEnd.clone(),
      direction: outwardDir.clone(),
    });

    // Store original line length for animation updates
    this.originalLineLengths.set(region.name, scaledLineLength);

    // Create styled line
    const lineConfig: Required<LineConfig> = {
      style: style.line.style ?? 'solid',
      curve: style.line.curve ?? 'straight',
      arrowHead: style.line.arrowHead ?? false,
      thickness: style.line.thickness ?? 2,
      length: lineLength,
    };

    const line = this.createStyledLine(
      surfacePoint,
      lineEnd,
      lineConfig,
      style.lineColor,
      0.9 * opacity,
      region.name
    );
    line.name = `line_${region.name}`;
    line.userData.annotation = region.name;
    line.visible = !startHidden && !region.isFallback;
    this.markerGroup.add(line);
    this.lineMeshes.set(region.name, line);

    // Create label at line end (using resolved style)
    const label = this.createLabelSprite(region, style);
    label.position.copy(lineEnd);
    label.name = `label_${region.name}`;
    label.userData.annotation = region.name;
    label.visible = !startHidden && !region.isFallback;
    this.markerGroup.add(label);
    this.labelSprites.set(region.name, label);
    this.labelScales.set(region.name, { x: label.scale.x, y: label.scale.y });

    // Hide arrow if marker starts hidden
    const arrow = this.arrowMeshes.get(region.name);
    if (arrow) {
      arrow.visible = !startHidden && !region.isFallback;
    }
    this.markerTargetVisibility.set(region.name, !startHidden && !region.isFallback);
    this.markerAngleGateVisibility.delete(region.name);
    this.markerViewportVisibility.set(region.name, true);

  }

  /**
   * Embody Rust owns endpoint layout; the Three adapter applies the returned positions
   * to its Three.js marker geometry and labels.
   */
  private separateOverlappingMarkers(annotationCameraCore: RustAnnotationCameraCore): void {
    const markerNames = Array.from(this.lineEndpoints.keys());
    if (markerNames.length < 2) {
      return;
    }

    const starts = new Float32Array(markerNames.length * 3);
    const ends = new Float32Array(markerNames.length * 3);
    markerNames.forEach((name, index) => {
      const endpoints = this.lineEndpoints.get(name)!;
      endpoints.start.toArray(starts, index * 3);
      endpoints.end.toArray(ends, index * 3);
    });

    const separatedEnds = annotationCameraCore.separateOverlappingMarkerEndpoints({
      starts,
      ends,
      modelCenter: this.modelCenter,
      modelHeight: this.modelSize.y,
    });
    if (separatedEnds.length !== ends.length) {
      throw new Error(
        `Marker endpoint separation returned ${separatedEnds.length} values for ${markerNames.length} markers`
      );
    }

    markerNames.forEach((name, index) => {
      const endpoints = this.lineEndpoints.get(name)!;
      const newEnd = new THREE.Vector3().fromArray(separatedEnds, index * 3);
      endpoints.direction.subVectors(newEnd, endpoints.start).normalize();
      this.updateMarkerGeometry(name, endpoints.start, newEnd);
    });
  }

  /**
   * Determine the outward direction for marker placement based on annotation type.
   *
   * This uses semantic knowledge about body parts:
   * - Face/eyes/mouth: forward (positive Z)
   * - Back: backward (negative Z)
   * - Left/right parts: semantic side, resolved against model laterality
   * - Feet: down (negative Y)
   * - If cameraAngle is specified, use that angle
   * - Default: direction from model center to annotation center
   */
  private getOutwardDirection(region: Region, annotationCenter: THREE.Vector3): THREE.Vector3 {
    const name = region.name.toLowerCase();
    const leftX = getSemanticHorizontalSignForSide('left', this.laterality);
    const rightX = getSemanticHorizontalSignForSide('right', this.laterality);

    const toWorld = (localDir: THREE.Vector3): THREE.Vector3 => {
      return toWorldDirection(this.model, localDir);
    };

    const resolvedCameraAngle = resolveRegionCameraAngle(region, this.laterality);

    // If annotation has a specific cameraAngle, use that direction in model-local space.
    if (resolvedCameraAngle !== undefined && resolvedCameraAngle !== 0) {
      return getWorldDirectionForCameraAngle(this.model, resolvedCameraAngle);
    }

    // Semantic direction based on region.name (in MODEL-LOCAL space, transformed to world).
    // Eyes should point outward to the semantic side of the model.
    const horizontalSign = getSemanticHorizontalSign(region.name, this.laterality);
    if (horizontalSign !== null && (name.includes('eye') || name.includes('hand'))) {
      return toWorld(new THREE.Vector3(horizontalSign, 0.1, 0.3).normalize());
    }

    // Eye (singular) - radial from center
    if (name === 'eye') {
      const dir = new THREE.Vector3().subVectors(annotationCenter, this.modelCenter);
      dir.y = 0;
      return dir.length() > 0.001 ? dir.normalize() : toWorld(new THREE.Vector3(0, 0, 1));
    }

    // Face/head/mouth should point FORWARD in model space
    if (name.includes('face') || name.includes('mouth') || name.includes('head')) {
      return toWorld(new THREE.Vector3(0, 0, 1));
    }

    // Full body points forward
    if (name.includes('full_body') || name.includes('full body')) {
      return toWorld(new THREE.Vector3(0, 0, 1));
    }

    // Body points forward
    if (name === 'body') {
      return toWorld(new THREE.Vector3(0, 0, 1));
    }

    // Upper body points forward
    if (name.includes('upper_body') || name.includes('torso') || name.includes('chest')) {
      return toWorld(new THREE.Vector3(0, 0, 1));
    }

    // Feet point down and slightly forward
    if (name.includes('foot') || name.includes('feet')) {
      return toWorld(new THREE.Vector3(0, -0.5, 0.5).normalize());
    }

    // Fins (for fish) - point toward outer edge of fin
    if (name.includes('pectoral')) {
      if (name.includes('left')) {
        return toWorld(new THREE.Vector3(leftX, -0.3, 0.2).normalize());
      } else if (name.includes('right')) {
        return toWorld(new THREE.Vector3(rightX, -0.3, 0.2).normalize());
      }
    }
    if (name.includes('ventral') || name.includes('pelvic')) {
      return toWorld(new THREE.Vector3(0, -0.7, -0.5).normalize());
    }
    if (name.includes('anal')) {
      // Anal fin points down and back
      return toWorld(new THREE.Vector3(0, -0.6, -0.6).normalize());
    }
    if (name.includes('dorsal')) {
      return toWorld(new THREE.Vector3(0, 1, -0.3).normalize());
    }
    if (name.includes('fin')) {
      if (name.includes('left')) {
        return toWorld(new THREE.Vector3(leftX, 0, 0));
      } else if (name.includes('right')) {
        return toWorld(new THREE.Vector3(rightX, 0, 0));
      }
    }

    // Tail/caudal fin points backward in model space
    if (name.includes('tail') || name.includes('caudal')) {
      return toWorld(new THREE.Vector3(0, 0, -1));
    }

    // Gills/operculum point to model's right side
    if (name.includes('gill') || name.includes('operculum')) {
      const semanticSign = getSemanticHorizontalSign(name, this.laterality);
      return toWorld(new THREE.Vector3(semanticSign ?? rightX, 0, 0.3).normalize());
    }

    // Mouth points forward
    if (name === 'mouth') {
      return toWorld(new THREE.Vector3(0, 0, 1));
    }

    // Throat points to model's left side
    if (name.includes('throat')) {
      return toWorld(new THREE.Vector3(leftX, 0, 0.3).normalize());
    }

    // Default: use direction from model center to annotation center (already in world space)
    const dir = new THREE.Vector3().subVectors(annotationCenter, this.modelCenter);
    if (dir.length() < 0.001) {
      return toWorld(new THREE.Vector3(0, 0, 1));
    }
    return dir.normalize();
  }

  /**
   * Find surface point by raycasting from OUTSIDE toward the annotation center.
   * This ensures we hit the outer surface facing the outward direction.
   */
  private findSurfacePoint(target: THREE.Vector3, outwardDir: THREE.Vector3): THREE.Vector3 {
    if (!this.model) return target.clone();

    if (this.modelMeshes.length === 0) return target.clone();

    const modelScale = Math.max(this.modelSize.x, this.modelSize.y, this.modelSize.z);
    const scale = this.modelSize.y / REFERENCE_MODEL_HEIGHT;

    // Cast ray from far outside, coming IN toward the target
    const rayOrigin = target.clone().add(outwardDir.clone().multiplyScalar(modelScale * 2));
    const rayDir = outwardDir.clone().negate();

    this.raycaster.set(rayOrigin, rayDir);
    this.raycaster.far = modelScale * 4;

    const hits = this.raycaster.intersectObjects(this.modelMeshes, false);

    // Find the first hit (outer surface)
    if (hits.length > 0) {
      const hit = hits[0].point.clone();
      // Offset slightly along outward direction to sit on surface
      hit.add(outwardDir.clone().multiplyScalar(this.config.markerRadius * scale));
      return hit;
    }

    // Fallback: try raycasting from model center outward through target
    const rayOrigin2 = this.modelCenter.clone();
    const rayDir2 = outwardDir.clone();
    this.raycaster.set(rayOrigin2, rayDir2);
    this.raycaster.far = modelScale * 2;

    const hits2 = this.raycaster.intersectObjects(this.modelMeshes, false);
    if (hits2.length > 0) {
      // Use the LAST hit (furthest out = outer surface)
      const hit = hits2[hits2.length - 1].point.clone();
      hit.add(outwardDir.clone().multiplyScalar(this.config.markerRadius * scale));
      return hit;
    }

    // Final fallback: place marker at annotation center offset outward
    return target.clone().add(outwardDir.clone().multiplyScalar(0.05 * scale));
  }

  private async findSurfacePointInSlices(
    target: THREE.Vector3,
    outwardDir: THREE.Vector3,
    isCurrent: () => boolean,
  ): Promise<THREE.Vector3 | null> {
    if (!isCurrent()) return null;
    if (!this.model || this.modelMeshes.length === 0) return target.clone();
    const meshes = this.modelMeshes;
    const modelCenter = this.modelCenter.clone();
    const modelScale = Math.max(this.modelSize.x, this.modelSize.y, this.modelSize.z);
    const scale = this.modelSize.y / REFERENCE_MODEL_HEIGHT;
    const raycaster = new THREE.Raycaster();
    const options = { isCurrent, yieldToPaint: waitForCharacterLoadPaint };
    raycaster.set(target.clone().addScaledVector(outwardDir, modelScale * 2), outwardDir.clone().negate());
    raycaster.far = modelScale * 4;
    const incoming = await intersectMeshesInSlices(raycaster, meshes, options);
    if (!incoming || !isCurrent()) return null;
    if (incoming.length > 0) {
      return incoming[0].point.clone().addScaledVector(outwardDir, this.config.markerRadius * scale);
    }

    // Separate the two searches too: an expensive last mesh must not be
    // followed by another query's first mesh in the same uninterrupted task.
    await waitForCharacterLoadPaint();
    if (!isCurrent()) return null;
    raycaster.set(modelCenter, outwardDir.clone());
    raycaster.far = modelScale * 2;
    const outgoing = await intersectMeshesInSlices(raycaster, meshes, options);
    if (!outgoing || !isCurrent()) return null;
    if (outgoing.length > 0) {
      return outgoing[outgoing.length - 1].point.clone().addScaledVector(outwardDir, this.config.markerRadius * scale);
    }
    return target.clone().addScaledVector(outwardDir, 0.05 * scale);
  }

  private getSuffixPattern(): string | undefined {
    return this.characterConfig?.suffixPattern;
  }

  /**
   * Get center point and bounding box of annotation's bones/meshes.
   * Uses fuzzy matching to handle bone names with numeric suffixes.
   */
  private getRegionCenterAndBox(
    region: Region,
  ): { center: THREE.Vector3; box: THREE.Box3; usedRuntimeMorphAnchor?: boolean } | null {
    const model = this.model;
    if (!model) return null;

    const resolvedAnchor = resolveMarkerAnchorRegion(region);
    const anchorRegion = resolvedAnchor.region;

    // Batch loads refresh once up front; one-off marker edits still need fresh
    // skeleton transforms before resolving their world positions.
    if (!this.regionLoadHasFreshMatrices) {
      model.updateMatrixWorld(true);
    }

    const modelRotation = new THREE.Matrix4();
    modelRotation.extractRotation(model.matrixWorld);
    const toWorldOffset = (localOffset: THREE.Vector3): THREE.Vector3 => {
      return localOffset.clone().applyMatrix4(modelRotation);
    };
    const leftX = getSemanticHorizontalSignForSide('left', this.laterality);
    const rightX = getSemanticHorizontalSignForSide('right', this.laterality);

    const box = new THREE.Box3();
    let found = false;
    let usedRuntimeMorphAnchor = false;
    const foundItems: string[] = [];

    // PRIORITY 0: If region has a custom position (user-adjusted), use it directly
    if (anchorRegion.customPosition) {
      const customCenter = new THREE.Vector3(
        anchorRegion.customPosition.x,
        anchorRegion.customPosition.y,
        anchorRegion.customPosition.z
      );
      box.expandByPoint(customCenter);
      console.log(`[3DMarkers] Region "${anchorRegion.name}" using customPosition: (${customCenter.x.toFixed(3)}, ${customCenter.y.toFixed(3)}, ${customCenter.z.toFixed(3)})`);
      return { center: customCenter, box };
    }

    // Handle full body (*)
    if (anchorRegion.objects?.includes('*')) {
      box.setFromObject(model);
      found = true;
      foundItems.push('full model');
    } else {
      // PRIORITY 1: For face regions, ALWAYS use resolveFaceCenter (embody)
      // This handles both user-selected meshes AND auto-detection by morph count
      // NEVER fall back to bone position for face regions (bones are at skull center = back of head)
      const isFaceRegion = shouldUseFaceCenterForMarkerAnchor(resolvedAnchor);

      if (isFaceRegion) {
        const hasMeshes = anchorRegion.meshes && anchorRegion.meshes.length > 0;
        console.log(`[3DMarkers] Face region "${anchorRegion.name}" - meshes: ${hasMeshes ? anchorRegion.meshes!.join(', ') : 'auto-detect by morph count'}`);

        // Use embody helper to find face center position
        // If no meshes provided, resolveFaceCenter will auto-detect by morph target count
        const faceCenterResult = resolveFaceCenter(model, anchorRegion, boneResolutionProfile(this.characterConfig) ?? undefined);

        console.log(`[3DMarkers] Face region "${anchorRegion.name}" - method: ${faceCenterResult.method}`);
        faceCenterResult.debugInfo.forEach(info => console.log(`[3DMarkers]   ${info}`));

        // Copy values to our THREE.Vector3 to avoid type issues
        const faceCenter = new THREE.Vector3(
          faceCenterResult.center.x,
          faceCenterResult.center.y,
          faceCenterResult.center.z
        );

        box.expandByPoint(faceCenter);
        found = true;
        foundItems.push(`face-center: ${faceCenterResult.method} at (${faceCenter.x.toFixed(2)}, ${faceCenter.y.toFixed(2)}, ${faceCenter.z.toFixed(2)})`);

        const center = new THREE.Vector3();
        box.getCenter(center);
        console.log(`[3DMarkers] Returning face center: (${center.x.toFixed(3)}, ${center.y.toFixed(3)}, ${center.z.toFixed(3)})`);
        return { center, box };
      }

      // PRIORITY 2: Find bones (with fuzzy matching for numeric suffixes)
      if (anchorRegion.bones) {
        const tempVec = new THREE.Vector3();
        const resolvedBoneNames = resolveBoneNames(anchorRegion.bones, boneResolutionProfile(this.characterConfig));

        for (const boneName of resolvedBoneNames) {
          model.traverse((obj) => {
            if (fuzzyNameMatch(obj.name, boneName, this.getSuffixPattern())) {
              obj.getWorldPosition(tempVec);
              box.expandByPoint(tempVec);
              found = true;
              foundItems.push(`bone:${obj.name} (matched ${boneName}) at (${tempVec.x.toFixed(2)}, ${tempVec.y.toFixed(2)}, ${tempVec.z.toFixed(2)})`);
            }
          });
        }
      }

      // Find meshes (with fuzzy matching for numeric suffixes)
      if (anchorRegion.meshes) {
        for (const meshName of anchorRegion.meshes) {
          model.traverse((obj) => {
            if (fuzzyNameMatch(obj.name, meshName, this.getSuffixPattern()) && (obj as THREE.Mesh).isMesh) {
              const mesh = obj as THREE.Mesh;
              const runtimeMorphAnchorPoint = getRuntimeAUMorphAnchorPoint(
                anchorRegion as AnnotationAnchoredRegion,
                mesh,
              );
              if (runtimeMorphAnchorPoint) {
                box.expandByPoint(runtimeMorphAnchorPoint);
                found = true;
                usedRuntimeMorphAnchor = true;
                foundItems.push(`runtime-morph:${meshName} at (${runtimeMorphAnchorPoint.x.toFixed(2)}, ${runtimeMorphAnchorPoint.y.toFixed(2)}, ${runtimeMorphAnchorPoint.z.toFixed(2)})`);
                return;
              }

              // For skinned meshes, the geometry is at origin - we need to find the
              // associated bone position instead, or compute world-space bounds
              let meshCenter = new THREE.Vector3();

              // Check if this is a skinned mesh by looking for a parent bone
              // or if the mesh has very small bounds near origin
              const meshBox = new THREE.Box3().setFromObject(mesh);
              meshBox.getCenter(meshCenter);

              // If center is near origin, this is likely a skinned mesh
              // Try to find the bone that controls it by name pattern
              if (meshCenter.length() < 0.1) {
                // For CC_Base_Eye and CC_Base_Eye_1, use the eye bones (CC4/human)
                if (meshName.includes('CC_Base_Eye')) {
                  const isLeft = !meshName.includes('_1'); // CC_Base_Eye is left, CC_Base_Eye_1 is right
                  const eyeBoneName = isLeft ? 'CC_Base_L_Eye' : 'CC_Base_R_Eye';
                  model.traverse((boneObj) => {
                    if (boneObj.name === eyeBoneName) {
                      boneObj.getWorldPosition(meshCenter);
                    }
                  });
                } else if (meshName === 'EYES_0') {
                  // Fish eye mesh - use head bone and offset forward + sideways
                  // The fish model is small and the head bone is deep inside the body,
                  // so we need a forward offset to reach the visible eye surface
                  // Additionally offset left/right based on region name for distinct eye markers
                  const regionNameLower = anchorRegion.name.toLowerCase();
                  const isLeftEye = regionNameLower.includes('left');
                  const isRightEye = regionNameLower.includes('right');
                  // Symmetric horizontal offset in MODEL space, aligned with semantic left/right.
                  const sideOffset = isLeftEye ? 0.035 * leftX : isRightEye ? 0.035 * rightX : 0;

                  model.traverse((boneObj) => {
                    // Match head bone (either hardcoded or via fuzzy match)
                    if (boneObj.name === 'Bone.001_Armature' || boneObj.name.includes('001_Armature')) {
                      boneObj.getWorldPosition(meshCenter);
                      // Offset in model-local space (will be transformed to world space):
                      // X = left(-)/right(+), Y = up/down, Z = forward(+)/back(-)
                      // Forward offset (Z) to reach eye surface, side offset (X) for left/right eye
                      meshCenter.add(toWorldOffset(new THREE.Vector3(sideOffset, 0.01, 0.1)));
                    }
                  });
                } else if (meshName.includes('Tongue') || meshName.includes('Teeth')) {
                  // For tongue/teeth, use jaw bone
                  model.traverse((boneObj) => {
                    if (boneObj.name === 'CC_Base_JawRoot') {
                      boneObj.getWorldPosition(meshCenter);
                    }
                  });
                } else {
                  // Fallback: use mesh world position
                  mesh.getWorldPosition(meshCenter);
                }
              }

              const runtimeSide = getRuntimeAnnotationSide(anchorRegion);
              const runtimeSideSign = runtimeSide === 'left'
                ? leftX
                : runtimeSide === 'right'
                  ? rightX
                  : 0;
              const runtimeSideOffset = runtimeSideSign
                ? getRuntimeAUMeshSideOffset(anchorRegion, runtimeSideSign, this.modelSize)
                : null;
              if (runtimeSideOffset) {
                meshCenter.add(toWorldOffset(runtimeSideOffset));
                foundItems.push(`runtime-side:${runtimeSide}`);
              }

              box.expandByPoint(meshCenter);
              found = true;
              foundItems.push(`mesh:${meshName} center at (${meshCenter.x.toFixed(2)}, ${meshCenter.y.toFixed(2)}, ${meshCenter.z.toFixed(2)})`);
            }
          });
        }
      }
    }

    if (!found || box.isEmpty()) {
      return null;
    }

    const center = new THREE.Vector3();
    box.getCenter(center);

    // For fin annotations, offset center toward the outer edge of the fin
    // Bones are at the base (near body), but markers should be on the outer edge
    if (!resolvedAnchor.useLegacyRegionSemantics) {
      return { center, box };
    }

    const name = anchorRegion.name.toLowerCase();
    const modelScale = Math.max(this.modelSize.x, this.modelSize.y, this.modelSize.z);
    const finOffset = modelScale * 0.15; // Offset based on model scale

    if (name.includes('pectoral')) {
      if (name.includes('left')) {
        center.add(toWorldOffset(new THREE.Vector3(leftX, -0.3, 0).multiplyScalar(finOffset)));
      } else if (name.includes('right')) {
        center.add(toWorldOffset(new THREE.Vector3(rightX, -0.3, 0).multiplyScalar(finOffset)));
      }
    } else if (name.includes('ventral') || name.includes('pelvic')) {
      center.add(toWorldOffset(new THREE.Vector3(0, -0.5, -0.3).multiplyScalar(finOffset)));
    } else if (name.includes('anal')) {
      center.add(toWorldOffset(new THREE.Vector3(0, -0.5, -0.5).multiplyScalar(finOffset)));
    } else if (name.includes('caudal') || name.includes('tail')) {
      center.add(toWorldOffset(new THREE.Vector3(0, 0, -0.8).multiplyScalar(finOffset)));
    } else if (name.includes('dorsal')) {
      center.add(toWorldOffset(new THREE.Vector3(0, 0.5, -0.3).multiplyScalar(finOffset)));
    } else if (name === 'mouth') {
      center.add(toWorldOffset(new THREE.Vector3(0, 0, 0.6).multiplyScalar(finOffset)));
    } else if (name.includes('operculum') || name.includes('gill')) {
      // Offset slightly to the side for gill cover
      const semanticSign = getSemanticHorizontalSign(name, this.laterality);
      center.add(
        toWorldOffset(new THREE.Vector3(0.3 * (semanticSign ?? rightX), 0, 0).multiplyScalar(finOffset))
      );
    }

    return { center, box, usedRuntimeMorphAnchor };
  }

  private formatLabelText(regionOrName: Region | string): string {
    const name = typeof regionOrName === 'string' ? regionOrName : regionOrName.name;
    const explicitLabel = typeof regionOrName === 'string'
      ? undefined
      : getAnnotationRegionLabel(regionOrName);
    const text = name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const children = this.parentChildIndex.get(name);
    if (children && children.length > 0) {
      const isExpanded = this.expandedRegions.get(name);
      return `${explicitLabel ?? text} ${isExpanded ? '-' : '+'}`;
    }
    return explicitLabel ?? text;
  }

  private buildLabelTexture(
    text: string,
    style?: Required<MarkerStyleOverrides>
  ): { texture: THREE.CanvasTexture; aspect: number } {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;

    // Use style if provided, otherwise fall back to config
    const fontSize = style?.labelFontSize ?? this.config.labelFontSize;
    const labelColor = style?.labelColor ?? this.config.labelColor;
    const labelBackground = style?.labelBackground ?? this.config.labelBackground;

    const font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.font = font;

    const padding = fontSize * 0.5;
    const textWidth = ctx.measureText(text).width;
    canvas.width = Math.ceil(textWidth + padding * 2);
    canvas.height = Math.ceil(fontSize + padding * 1.5);

    // Background
    ctx.fillStyle = labelBackground;
    const r = fontSize * 0.3;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, r);
    ctx.fill();

    // Border (derive from marker color if style provided)
    const borderColor = style ? `rgba(${(style.lineColor >> 16) & 0xff}, ${(style.lineColor >> 8) & 0xff}, ${style.lineColor & 0xff}, 0.6)` : 'rgba(66, 153, 225, 0.6)';
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(1, 1, canvas.width - 2, canvas.height - 2, r);
    ctx.stroke();

    // Text
    ctx.font = font;
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const aspect = canvas.width / canvas.height;

    return { texture, aspect };
  }

  private createLabelSprite(regionOrName: Region | string, style?: Required<MarkerStyleOverrides>): THREE.Sprite {
    const text = this.formatLabelText(regionOrName);
    const { texture, aspect } = this.buildLabelTexture(text, style);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        sizeAttenuation: false, // Disable size attenuation - we'll scale manually for consistent screen size
      })
    );

    // With sizeAttenuation: false, sprite scale is in normalized device coordinates (screen space)
    // Use a fixed screen-relative scale so labels appear same size regardless of model/camera distance
    const baseScale = 0.024; // Fixed screen-relative size
    sprite.scale.set(baseScale * aspect, baseScale, 1);

    return sprite;
  }

  private updateLabelSprite(name: string): void {
    const label = this.labelSprites.get(name);
    if (!label) return;
    const style = this.resolvedStyles.get(name);
    const text = this.formatLabelText(name);
    const { texture, aspect } = this.buildLabelTexture(text, style);
    const material = label.material as THREE.SpriteMaterial;
    if (material.map) material.map.dispose();
    material.map = texture;
    material.needsUpdate = true;

    const baseScale = 0.024;
    label.scale.set(baseScale * aspect, baseScale, 1);
    this.labelScales.set(name, { x: baseScale * aspect, y: baseScale });
  }

  private updateMarkerStyles(): void {
    // Get current zoom scale factors
    const labelScale = this.isZoomedIn ? ZOOMED_IN_LABEL_SCALE : 1.0;

    for (const [name, sphere] of this.markerMeshes) {
      const line = this.lineMeshes.get(name);
      const label = this.labelSprites.get(name);
      const baseScale = this.labelScales.get(name);
      const isSelected = name === this.currentRegion;

      // Use per-region resolved style (respects runtime style updates)
      const style = this.resolvedStyles.get(name);
      const markerColor = style?.markerColor ?? this.config.markerColor;
      const lineColor = style?.lineColor ?? this.config.lineColor;

      (sphere.material as THREE.MeshBasicMaterial).color.setHex(
        isSelected ? 0x63b3ed : markerColor
      );
      // Selection highlight scale (distance-based scaling is handled in update())
      if (isSelected) {
        const currentScale = sphere.scale.x; // Preserve distance-based scale
        sphere.scale.setScalar(currentScale * 1.3);
      }

      if (line) {
        (line.material as THREE.LineBasicMaterial).color.setHex(
          isSelected ? 0x63b3ed : lineColor
        );
        (line.material as THREE.LineBasicMaterial).opacity = isSelected ? 1 : (this.isZoomedIn ? 0.6 : 0.9);
      }

      if (label && baseScale) {
        const s = isSelected ? 1.1 : 1;
        // Apply label scale with selection highlight (labels stay more readable)
        label.scale.set(baseScale.x * s * labelScale, baseScale.y * s * labelScale, 1);
      }
    }
  }

  private getResolvedLineConfig(name: string): Required<LineConfig> {
    const style = this.resolvedStyles.get(name);
    return {
      style: style?.line.style ?? 'solid',
      curve: style?.line.curve ?? 'straight',
      arrowHead: style?.line.arrowHead ?? false,
      thickness: style?.line.thickness ?? 2,
      length: style?.line.length ?? this.config.lineLength,
    };
  }

  private getViewportSafeBounds(label: THREE.Sprite): { safeX: number; safeY: number } {
    const rect = this.domElement.getBoundingClientRect();
    return resolveViewportSafeBounds({
      labelScaleX: label.scale.x,
      labelScaleY: label.scale.y,
      projectionXScale: this.camera.projectionMatrix.elements[0] ?? 1,
      projectionYScale: this.camera.projectionMatrix.elements[5] ?? 1,
      viewportWidth: rect.width || this.domElement.clientWidth,
      viewportHeight: rect.height || this.domElement.clientHeight,
    });
  }

  private updateMarkerGeometry(name: string, start: THREE.Vector3, end: THREE.Vector3): void {
    const line = this.lineMeshes.get(name);
    const label = this.labelSprites.get(name);
    const arrow = this.arrowMeshes.get(name);
    const endpoints = this.lineEndpoints.get(name);
    if (!line || !label || !endpoints) return;

    endpoints.start.copy(start);
    endpoints.end.copy(end);

    const lineConfig = this.getResolvedLineConfig(name);
    let points: THREE.Vector3[] | null = null;

    if (lineConfig.curve === 'straight') {
      const positions = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (positions?.count === 2) {
        positions.setXYZ(0, start.x, start.y, start.z);
        positions.setXYZ(1, end.x, end.y, end.z);
        positions.needsUpdate = true;
      } else {
        points = [start.clone(), end.clone()];
        line.geometry.setFromPoints(points);
      }
    } else {
      points = lineConfig.curve === 'bezier'
        ? this.createBezierCurve(start, end)
        : this.createArcCurve(start, end);
      line.geometry.setFromPoints(points);
    }

    if (line.material instanceof THREE.LineDashedMaterial) {
      line.computeLineDistances();
    }

    label.position.copy(end);

    if (arrow) {
      const tip = points ? points[points.length - 1] : end;
      const prev = points ? points[points.length - 2] : start;
      arrow.position.copy(tip);
      this.scratchArrowDirection.subVectors(tip, prev);
      if (this.scratchArrowDirection.lengthSq() > POSITION_EPSILON_SQUARED) {
        this.scratchArrowQuaternion.setFromUnitVectors(
          this.arrowUp,
          this.scratchArrowDirection.normalize(),
        );
        arrow.setRotationFromQuaternion(this.scratchArrowQuaternion);
      }
    }
  }

  private updateMarkerLineLayout(name: string): boolean {
    const sphere = this.markerMeshes.get(name);
    const label = this.labelSprites.get(name);
    const endpoints = this.lineEndpoints.get(name);
    const originalLength = this.originalLineLengths.get(name);

    if (!sphere || !label || !endpoints || originalLength === undefined) {
      this.markerViewportVisibility.set(name, true);
      return true;
    }

    const lineScaleFactor = this.isZoomedIn ? ZOOMED_IN_LINE_SCALE : 1.0;
    const fullLength = originalLength * lineScaleFactor;
    const start = sphere.position;

    this.scratchWorldEnd
      .copy(endpoints.direction)
      .multiplyScalar(fullLength)
      .add(start);

    const { safeX, safeY } = this.getViewportSafeBounds(label);
    this.scratchClipStart
      .set(start.x, start.y, start.z, 1)
      .applyMatrix4(this.camera.matrixWorldInverse)
      .applyMatrix4(this.camera.projectionMatrix);
    this.scratchClipEnd
      .set(this.scratchWorldEnd.x, this.scratchWorldEnd.y, this.scratchWorldEnd.z, 1)
      .applyMatrix4(this.camera.matrixWorldInverse)
      .applyMatrix4(this.camera.projectionMatrix);

    if (!isFiniteClipPoint(this.scratchClipEnd)) {
      this.markerViewportVisibility.set(name, false);
      return false;
    }
    const { visible, lineScale } = requireAnnotationCameraCore().resolveViewportConstrainedLineScale({
      startClip: this.scratchClipStart.toArray(this.scratchClipStartValues),
      endClip: this.scratchClipEnd.toArray(this.scratchClipEndValues),
      safeX,
      safeY,
    });
    this.markerViewportVisibility.set(name, visible);

    if (!visible) {
      return false;
    }

    this.scratchConstrainedEnd
      .copy(endpoints.direction)
      .multiplyScalar(fullLength * lineScale)
      .add(start);

    if (
      start.distanceToSquared(endpoints.start) > POSITION_EPSILON_SQUARED ||
      this.scratchConstrainedEnd.distanceToSquared(endpoints.end) > POSITION_EPSILON_SQUARED
    ) {
      this.updateMarkerGeometry(name, start, this.scratchConstrainedEnd);
    }

    return true;
  }

  private onClick = (event: MouseEvent): void => {
    const rect = this.domElement.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.mouse, this.camera);

    const clickables = [...this.markerMeshes.values(), ...this.labelSprites.values()];
    const hits = this.raycaster.intersectObjects(clickables, false);

    if (hits.length > 0 && hits[0].object.userData.annotation) {
      const regionName = hits[0].object.userData.annotation;

      // If this is a parent region with children, toggle expand/collapse
      const children = this.parentChildIndex.get(regionName);
      if (children && children.length > 0) {
        const region = this.regions.find(r => r.name === regionName);
        const animation = region?.expandAnimation || 'staggered';
        this.toggleRegion(regionName, animation);
      }

      // Always call onSelect for camera focus
      this.onSelect(regionName);
    }
  };

  /**
   * Update marker positions to follow animated bones.
   * Uses stored bone references and local offsets for efficiency.
   */
  private updateMarkerPositions(): void {
    for (const [name, bone] of this.boneRefs) {
      const sphere = this.markerMeshes.get(name);
      const localOffset = this.localOffsets.get(name);

      if (!sphere || !localOffset) continue;

      // Transform local offset to world space using current bone matrix
      const newSurfacePoint = this.tempSurfacePoint.copy(localOffset).applyMatrix4(bone.matrixWorld);
      sphere.position.copy(newSurfacePoint);
    }
  }

  /**
   * Find the primary bone for a region (for animation tracking).
   */
  private findPrimaryBone(region: Region): THREE.Object3D | null {
    if (!this.model) return null;

    // For full body markers, don't track any bone
    if (region.objects?.includes('*')) return null;

    // Find first bone from the region's bones list
    if (region.bones && region.bones.length > 0) {
      const primaryBoneName = resolveBoneNames([region.bones[0]], boneResolutionProfile(this.characterConfig))[0];
      let foundBone: THREE.Object3D | null = null;

      this.model.traverse((obj) => {
        if (!foundBone && fuzzyNameMatch(obj.name, primaryBoneName, this.getSuffixPattern())) {
          foundBone = obj;
        }
      });

      return foundBone;
    }

    // For mesh-only regions, find the mesh
    if (region.meshes && region.meshes.length > 0) {
      const primaryMeshName = region.meshes[0];
      let foundMesh: THREE.Object3D | null = null;

      this.model.traverse((obj) => {
        if (!foundMesh && fuzzyNameMatch(obj.name, primaryMeshName, this.getSuffixPattern()) && (obj as THREE.Mesh).isMesh) {
          foundMesh = obj;
        }
      });

      return foundMesh;
    }

    return null;
  }

  /**
   * Per-frame update: distance-based scaling + explicit cameraAngle visibility.
   * Markers scale continuously with camera distance to maintain consistent screen size.
   * Occlusion is handled by the GPU via depth testing (depthTest: true).
   */
  update(): void {
    if (!this.model) return;

    // Hidden markers do not need per-frame bone tracking or visibility work.
    if (!this.markerGroup.visible && !this.visibilityAnimationActive) {
      return;
    }

    // Update marker positions to follow animated bones (like HTML markers do)
    this.updateMarkerPositions();

    // Let the short visibility animation own scale/opacity while it runs.
    if (this.visibilityAnimationActive) {
      return;
    }

    const dx = this.camera.position.x - this.modelCenter.x;
    const dy = this.camera.position.y - this.modelCenter.y;
    const dz = this.camera.position.z - this.modelCenter.z;

    const cameraDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Only update if distance changed by more than 2% (avoids micro-updates)
    const distanceChanged = this.lastCameraDistance < 0 ||
      Math.abs(cameraDistance - this.lastCameraDistance) > this.lastCameraDistance * 0.02;

    if (distanceChanged) {
      const previousDistance = this.lastCameraDistance;
      this.lastCameraDistance = cameraDistance;

      // Scale markers proportionally to camera distance to maintain consistent screen size
      // Reference distance is the zoom threshold - at this distance, scale = 1.0
      const referenceDistance = this.zoomThreshold;
      const distanceScale = cameraDistance / referenceDistance;

      // Clamp the scale to reasonable bounds (0.3x to 2.0x)
      const clampedScale = Math.max(0.3, Math.min(2.0, distanceScale));

      // Apply continuous scaling to spheres
      for (const sphere of this.markerMeshes.values()) {
        sphere.scale.setScalar(clampedScale);
      }

      // Update zoom state for other effects (line length, label scale, etc.)
      const shouldBeZoomedIn = cameraDistance < this.zoomThreshold;
      if (shouldBeZoomedIn !== this.isZoomedIn) {
        this.isZoomedIn = shouldBeZoomedIn;
        // Apply zoom-based scaling to lines and labels when crossing threshold
        this.applyZoomScale(shouldBeZoomedIn ? ZOOMED_IN_LINE_SCALE : 1.0);
      }

      // Auto-collapse only when crossing the threshold to avoid immediate re-collapse.
      const crossedAutoCollapseThreshold =
        previousDistance >= 0 &&
        previousDistance <= this.autoCollapseThreshold &&
        cameraDistance > this.autoCollapseThreshold;
      if (crossedAutoCollapseThreshold) {
        this.collapseAllRegions();
      }
    }

    const cameraMoved =
      !this.hasCameraAngleUpdateSnapshot ||
      this.lastCameraAngleUpdatePosition.distanceToSquared(this.camera.position) > 0.0001 ||
      1 - Math.abs(this.lastCameraAngleUpdateQuaternion.dot(this.camera.quaternion)) > 0.00001;
    if (!cameraMoved) {
      return;
    }

    this.lastCameraAngleUpdatePosition.copy(this.camera.position);
    this.lastCameraAngleUpdateQuaternion.copy(this.camera.quaternion);
    this.hasCameraAngleUpdateSnapshot = true;

    // Visibility comes from the combination of:
    // - collapsed child state
    // - solo mode
    // - explicit cameraAngle gates
    // Front-facing markers still rely on GPU depth testing for occlusion.
    //
    // cameraAngle-driven transitions should animate, while structural visibility
    // changes (collapse/solo) should apply immediately.
    const cameraAngle = getModelLocalOrbitAngle(this.model, this.modelCenter, this.camera.position);

    for (const [name, sphere] of this.markerMeshes) {
      const markerAngle = sphere.userData.cameraAngle;
      const isStructurallyVisible = shouldShow3DMarker({
        name,
        hiddenChildren: this.hiddenChildren,
        soloedMarker: this.soloedMarker,
      });
      const shouldPassAngleGate = requireAnnotationCameraCore().passesMarkerCameraAngleGate({
        markerAngle,
        currentCameraAngle: cameraAngle,
      });
      const passesViewportGate = isStructurallyVisible && shouldPassAngleGate
        ? this.updateMarkerLineLayout(name)
        : (this.markerViewportVisibility.get(name) ?? true);
      const visible = isStructurallyVisible && shouldPassAngleGate && passesViewportGate;

      const hadAngleGate = markerAngle !== undefined && markerAngle !== 0;
      const previousAngleGate = this.markerAngleGateVisibility.get(name);
      this.markerAngleGateVisibility.set(name, shouldPassAngleGate);
      const angleGateChanged =
        hadAngleGate &&
        previousAngleGate !== undefined &&
        previousAngleGate !== shouldPassAngleGate;

      if (!isStructurallyVisible) {
        this.stopMarkerVisibilityAnimation(name, true);
        this.setMarkerObjectsVisible(name, false);
        continue;
      }

      if (angleGateChanged) {
        this.animateMarkerVisibility(name, visible, VISIBILITY_ANIMATION_DURATION);
        continue;
      }

      if (!this.activeMarkerVisibilityAnimations.has(name)) {
        this.setMarkerObjectsVisible(name, visible);
      }
    }
  }

  private refreshLaterality(): void {
    this.laterality = detectAnnotationLaterality(this.model, this.regions, boneResolutionProfile(this.characterConfig));
  }

  /**
   * Apply zoom-based scaling to all markers, lines, and labels.
   * Only called when crossing the zoom threshold (not every frame).
   */
  private applyZoomScale(scaleFactor: number): void {
    const isZoomed = scaleFactor < 1;
    const sphereScaleFactor = isZoomed ? ZOOMED_IN_SPHERE_SCALE : 1.0;
    const labelScaleFactor = isZoomed ? ZOOMED_IN_LABEL_SCALE : 1.0;

    // Scale marker spheres (much smaller when zoomed in)
    for (const sphere of this.markerMeshes.values()) {
      sphere.scale.setScalar(sphereScaleFactor);
    }

    for (const line of this.lineMeshes.values()) {
      const material = line.material as THREE.LineBasicMaterial;
      material.opacity = isZoomed ? 0.6 : 0.9;
    }

    // Scale labels using their stored base scales (labels stay more readable)
    for (const [name, label] of this.labelSprites) {
      const baseScale = this.labelScales.get(name);
      if (baseScale) {
        label.scale.set(
          baseScale.x * labelScaleFactor,
          baseScale.y * labelScaleFactor,
          1
        );
      }
    }
  }

  setVisible(visible: boolean): void {
    this.animateVisibility(visible);
  }

  private readObjectOpacity(object: { material?: THREE.Material | THREE.Material[] }): number {
    if (!object.material) return 1;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const materialWithOpacity = materials.find((material) => 'opacity' in material) as THREE.Material | undefined;
    return materialWithOpacity && 'opacity' in materialWithOpacity
      ? materialWithOpacity.opacity
      : 1;
  }

  private setObjectOpacity(object: { material?: THREE.Material | THREE.Material[] }, opacity: number): void {
    if (!object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if ('opacity' in material) {
        material.transparent = true;
        material.opacity = opacity;
        material.needsUpdate = true;
      }
    }
  }

  private captureVisibilityAnimationStates(): MarkerVisibilityAnimationState[] {
    const states: MarkerVisibilityAnimationState[] = [];

    for (const [name, sphere] of this.markerMeshes) {
      const line = this.lineMeshes.get(name);
      const label = this.labelSprites.get(name);
      const arrow = this.arrowMeshes.get(name);

      const state: MarkerVisibilityAnimationState = {};

      if (sphere.visible) {
        state.sphere = {
          object: sphere,
          opacity: this.readObjectOpacity(sphere),
        };
      }

      if (line?.visible) {
        state.line = {
          object: line,
          opacity: this.readObjectOpacity(line),
        };
      }

      if (label?.visible) {
        state.label = {
          object: label,
          opacity: this.readObjectOpacity(label),
          scale: label.scale.clone(),
        };
      }

      if (arrow?.visible) {
        state.arrow = {
          object: arrow,
          opacity: this.readObjectOpacity(arrow),
        };
      }

      if (state.sphere || state.line || state.label || state.arrow) {
        states.push(state);
      }
    }

    return states;
  }

  private getVisibilityAnimationFactors(visible: boolean, t: number): {
    itemOpacityFactor: number;
    labelScaleFactor: number;
    lineOpacityFactor: number;
  } {
    return requireAnnotationCameraCore().markerVisibilityAnimationFactors(visible, t);
  }

  private applyVisibilityAnimationStates(
    states: MarkerVisibilityAnimationState[],
    visible: boolean,
    t: number
  ): void {
    const { itemOpacityFactor, labelScaleFactor, lineOpacityFactor } = this.getVisibilityAnimationFactors(visible, t);

    for (const state of states) {
      if (state.sphere) {
        const { object, opacity } = state.sphere;
        object.visible = true;
        this.setObjectOpacity(object, opacity * itemOpacityFactor);
      }

      if (state.line) {
        const { object, opacity } = state.line;
        object.visible = true;
        this.setObjectOpacity(object, opacity * lineOpacityFactor);
      }

      if (state.label) {
        const { object, opacity, scale } = state.label;
        object.visible = true;
        object.scale.set(scale.x * labelScaleFactor, scale.y * labelScaleFactor, scale.z);
        this.setObjectOpacity(object, opacity * itemOpacityFactor);
      }

      if (state.arrow) {
        const { object, opacity } = state.arrow;
        object.visible = true;
        this.setObjectOpacity(object, opacity * itemOpacityFactor);
      }
    }
  }

  private restoreVisibilityAnimationStates(states: MarkerVisibilityAnimationState[]): void {
    for (const state of states) {
      if (state.sphere) {
        const { object, opacity } = state.sphere;
        this.setObjectOpacity(object, opacity);
      }

      if (state.line) {
        const { object, opacity } = state.line;
        this.setObjectOpacity(object, opacity);
      }

      if (state.label) {
        const { object, opacity, scale } = state.label;
        object.scale.copy(scale);
        this.setObjectOpacity(object, opacity);
      }

      if (state.arrow) {
        const { object, opacity } = state.arrow;
        this.setObjectOpacity(object, opacity);
      }
    }
  }

  private stopAllMarkerVisibilityAnimations(restoreState = false): void {
    for (const name of new Set([
      ...this.activeMarkerVisibilityAnimations,
      ...this.markerVisibilityAnimationStates.keys(),
    ])) {
      this.stopMarkerVisibilityAnimation(name, restoreState);
    }
  }

  private stopMarkerVisibilityAnimation(name: string, restoreState = false): void {
    this.visibilityAnimationScheduler.cancel(`marker:${name}`);
    this.activeMarkerVisibilityAnimations.delete(name);

    if (restoreState) {
      const state = this.markerVisibilityAnimationStates.get(name);
      if (state) {
        this.restoreVisibilityAnimationStates([state]);
      }
    }

    this.markerVisibilityAnimationStates.delete(name);
  }

  private getMarkerTargetVisibility(name: string): boolean {
    const target = this.markerTargetVisibility.get(name);
    if (target !== undefined) return target;
    return this.markerMeshes.get(name)?.visible ?? false;
  }

  private setMarkerObjectsVisible(name: string, visible: boolean, persistTarget = true): void {
    const sphere = this.markerMeshes.get(name);
    const line = this.lineMeshes.get(name);
    const label = this.labelSprites.get(name);
    const arrow = this.arrowMeshes.get(name);

    if (sphere) sphere.visible = visible;
    if (line) line.visible = visible;
    if (label) label.visible = visible;
    if (arrow) arrow.visible = visible;
    if (persistTarget) {
      this.markerTargetVisibility.set(name, visible);
    }
  }

  private getMarkerFallbackOpacity(name: string, kind: 'sphere' | 'line' | 'label' | 'arrow'): number {
    const style = this.resolvedStyles.get(name);

    switch (kind) {
      case 'sphere':
        return 0.95 * (style?.opacity ?? 1);
      case 'line':
        return name === this.currentRegion ? 1 : (this.isZoomedIn ? 0.6 : 0.9);
      case 'label':
        return 1;
      case 'arrow':
        return style?.opacity ?? 1;
    }
  }

  private getMarkerBaseLabelScale(name: string, label: THREE.Sprite): THREE.Vector3 {
    if (label.scale.x > 0.001 && label.scale.y > 0.001) {
      return label.scale.clone();
    }

    const baseScale = this.labelScales.get(name);
    if (!baseScale) {
      return new THREE.Vector3(1, 1, 1);
    }

    const selectionScale = name === this.currentRegion ? 1.1 : 1;
    const zoomScale = this.isZoomedIn ? ZOOMED_IN_LABEL_SCALE : 1;

    return new THREE.Vector3(
      baseScale.x * selectionScale * zoomScale,
      baseScale.y * selectionScale * zoomScale,
      1,
    );
  }

  private captureMarkerVisibilityAnimationState(name: string): MarkerVisibilityAnimationState | null {
    const sphere = this.markerMeshes.get(name);
    const line = this.lineMeshes.get(name);
    const label = this.labelSprites.get(name);
    const arrow = this.arrowMeshes.get(name);

    const state: MarkerVisibilityAnimationState = {};

    if (sphere) {
      state.sphere = {
        object: sphere,
        opacity: Math.max(
          this.readObjectOpacity(sphere),
          this.getMarkerFallbackOpacity(name, 'sphere'),
        ),
      };
    }

    if (line) {
      state.line = {
        object: line,
        opacity: Math.max(
          this.readObjectOpacity(line),
          this.getMarkerFallbackOpacity(name, 'line'),
        ),
      };
    }

    if (label) {
      state.label = {
        object: label,
        opacity: Math.max(
          this.readObjectOpacity(label),
          this.getMarkerFallbackOpacity(name, 'label'),
        ),
        scale: this.getMarkerBaseLabelScale(name, label),
      };
    }

    if (arrow) {
      state.arrow = {
        object: arrow,
        opacity: Math.max(
          this.readObjectOpacity(arrow),
          this.getMarkerFallbackOpacity(name, 'arrow'),
        ),
      };
    }

    if (state.sphere || state.line || state.label || state.arrow) {
      return state;
    }

    return null;
  }

  // Child expand/collapse should use the exact same opacity and label-scale treatment
  // as the normal marker show/hide path. The earlier regressions came from layering a
  // second bespoke animation system on top of expansion instead of reusing this one.
  private animateMarkerVisibility(name: string, visible: boolean, duration: number): void {
    if (this.getMarkerTargetVisibility(name) === visible) {
      return;
    }
    this.markerTargetVisibility.set(name, visible);

    this.stopMarkerVisibilityAnimation(name, true);

    const state = this.captureMarkerVisibilityAnimationState(name);
    if (!state) {
      this.setMarkerObjectsVisible(name, visible, false);
      return;
    }

    this.markerVisibilityAnimationStates.set(name, state);
    this.setMarkerObjectsVisible(name, true, false);

    const startTime = performance.now();
    this.activeMarkerVisibilityAnimations.add(name);
    this.visibilityAnimationScheduler.schedule(`marker:${name}`, (now): boolean => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      this.applyVisibilityAnimationStates([state], visible, t);

      if (t < 1) {
        return true;
      }

      this.activeMarkerVisibilityAnimations.delete(name);
      this.markerVisibilityAnimationStates.delete(name);
      this.restoreVisibilityAnimationStates([state]);
      this.setMarkerObjectsVisible(name, visible, false);
      return false;
    });
  }

  private stopVisibilityAnimation(restoreState = false): void {
    this.visibilityAnimationScheduler.cancel(GROUP_VISIBILITY_ANIMATION_KEY);
    this.visibilityAnimationActive = false;

    if (restoreState && this.visibilityAnimationStates.length > 0) {
      this.markerGroup.visible = true;
      this.restoreVisibilityAnimationStates(this.visibilityAnimationStates);
    }
  }

  private animateVisibility(visible: boolean): void {
    if (visible === this.markerGroup.visible && !this.visibilityAnimationActive) {
      return;
    }

    this.stopAllMarkerVisibilityAnimations(true);
    this.stopVisibilityAnimation(true);

    if (visible) {
      this.markerGroup.visible = true;
    }

    this.visibilityAnimationStates = this.captureVisibilityAnimationStates();
    if (this.visibilityAnimationStates.length === 0) {
      this.markerGroup.visible = visible;
      return;
    }

    const startTime = performance.now();
    this.visibilityAnimationActive = true;
    this.visibilityAnimationScheduler.schedule(GROUP_VISIBILITY_ANIMATION_KEY, (now): boolean => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / VISIBILITY_ANIMATION_DURATION, 1);
      this.applyVisibilityAnimationStates(this.visibilityAnimationStates, visible, t);

      if (t < 1) {
        return true;
      }

      this.visibilityAnimationActive = false;
      this.restoreVisibilityAnimationStates(this.visibilityAnimationStates);
      if (!visible) {
        this.markerGroup.visible = false;
      }
      this.visibilityAnimationStates = [];
      return false;
    });
  }

  clear(): void {
    this.regionLoadGeneration += 1;
    this.regionLoadHasFreshMatrices = false;
    this.stopAllMarkerVisibilityAnimations(false);
    this.stopVisibilityAnimation(false);
    this.visibilityAnimationStates = [];
    while (this.markerGroup.children.length > 0) {
      const child = this.markerGroup.children[0];
      this.markerGroup.remove(child);

      const mesh = child as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) {
        const mat = mesh.material as THREE.Material;
        if ((mat as THREE.SpriteMaterial).map) {
          (mat as THREE.SpriteMaterial).map!.dispose();
        }
        mat.dispose();
      }
    }

    this.markerMeshes.clear();
    this.lineMeshes.clear();
    this.lineEndpoints.clear();
    this.labelSprites.clear();
    this.labelScales.clear();
    this.arrowMeshes.clear();
    this.resolvedStyles.clear();
    this.expandedRegions.clear();
    this.parentChildIndex.clear();
    this.childParentIndex.clear();
    this.hiddenChildren.clear();
    this.groupVisibility.clear();
    this.originalLineLengths.clear();
    this.boneRefs.clear();
    this.localOffsets.clear();
    this.markerTargetVisibility.clear();
    this.markerAngleGateVisibility.clear();
    this.markerViewportVisibility.clear();
    this.soloedMarker = null;
    this.hasCameraAngleUpdateSnapshot = false;
  }

  // ============ SOLO MODE ============

  /**
   * Solo a specific marker - hide all others.
   * Pass null to unsolo.
   */
  setSoloMarker(regionName: string | null): void {
    this.soloedMarker = regionName;

    for (const [name] of this.markerMeshes) {
      const shouldShow = regionName === null || name === regionName;
      const region = this.regions.find(r => r.name === name);

      // Skip fallback markers (they have their own visibility logic)
      if (region?.isFallback) continue;

      this.stopMarkerVisibilityAnimation(name, true);
      this.setMarkerObjectsVisible(name, shouldShow);
    }
  }

  /**
   * Get currently soloed marker name.
   */
  getSoloedMarker(): string | null {
    return this.soloedMarker;
  }

  // ============ EXPANDING ANCHORS ============

  /**
   * Expand a parent region to show its children.
   */
  async expandRegion(
    regionName: string,
    animation: ExpandAnimation = 'outward',
    duration = VISIBILITY_ANIMATION_DURATION
  ): Promise<void> {
    const children = this.parentChildIndex.get(regionName);
    if (!children || children.length === 0) return;

    // Already expanded
    if (this.expandedRegions.get(regionName)) return;

    this.expandedRegions.set(regionName, true);
    this.updateLabelSprite(regionName);

    // Get parent position
    const parentSphere = this.markerMeshes.get(regionName);
    if (!parentSphere) return;
    const parentPos = parentSphere.position.clone();

    // Animate children
    const staggerDelay = animation === 'staggered' ? 50 : 0;

    for (let i = 0; i < children.length; i++) {
      const childName = children[i];
      const delay = i * staggerDelay;
      this.hiddenChildren.delete(childName);

      // Schedule animation
      setTimeout(() => {
        this.animateMarkerIn(childName, parentPos, duration);
      }, delay);
    }
  }

  /**
   * Collapse a parent region to hide its children.
   */
  async collapseRegion(
    regionName: string,
    duration = VISIBILITY_ANIMATION_DURATION
  ): Promise<void> {
    const children = this.parentChildIndex.get(regionName);
    if (!children || children.length === 0) return;

    // Already collapsed
    if (!this.expandedRegions.get(regionName)) return;

    this.expandedRegions.set(regionName, false);
    this.updateLabelSprite(regionName);

    // Get parent position for animation target
    const parentSphere = this.markerMeshes.get(regionName);
    if (!parentSphere) return;
    const parentPos = parentSphere.position.clone();

    // Animate children out
    for (const childName of children) {
      this.animateMarkerOut(childName, parentPos, duration);
      setTimeout(() => {
        this.hiddenChildren.add(childName);
      }, duration);
    }
  }

  /**
   * Toggle expand/collapse state.
   */
  toggleRegion(
    regionName: string,
    animation: ExpandAnimation = 'outward',
    duration = VISIBILITY_ANIMATION_DURATION
  ): void {
    if (this.expandedRegions.get(regionName)) {
      this.collapseRegion(regionName, duration * 0.75);
    } else {
      this.expandRegion(regionName, animation, duration);
    }
  }

  /**
   * Get expanded state of all regions.
   */
  getExpandedRegions(): ExpandedRegionState[] {
    const states: ExpandedRegionState[] = [];
    for (const [regionName, isExpanded] of this.expandedRegions) {
      const children = this.parentChildIndex.get(regionName) || [];
      states.push({ regionName, isExpanded, children });
    }
    return states;
  }

  /**
   * Collapse all currently expanded regions.
   * Called automatically when zooming out past threshold.
   */
  private collapseAllRegions(duration = VISIBILITY_ANIMATION_DURATION): void {
    // Get list of expanded regions (iterate copy to avoid mutation during iteration)
    const expandedList = [...this.expandedRegions.entries()]
      .filter(([_, isExpanded]) => isExpanded)
      .map(([name, _]) => name);

    if (expandedList.length === 0) return;

    // Collapse all expanded regions
    for (const regionName of expandedList) {
      this.collapseRegion(regionName, duration);
    }
  }

  /**
   * Animate a child marker in place using the same visibility curve as regular markers.
   */
  private animateMarkerIn(name: string, _fromPos: THREE.Vector3, duration: number): void {
    this.animateMarkerVisibility(name, true, duration);
  }

  /**
   * Animate a child marker out in place using the same visibility curve as regular markers.
   */
  private animateMarkerOut(name: string, _toPos: THREE.Vector3, duration: number): void {
    this.animateMarkerVisibility(name, false, duration);
  }

  // ============ RUNTIME STYLE UPDATES ============

  /**
   * Update line style for a specific region at runtime.
   */
  updateLineStyle(regionName: string, lineConfig: Partial<LineConfig>): void {
    console.log(`[3DMarkers] updateLineStyle: region=${regionName}`, lineConfig);
    const style = this.resolvedStyles.get(regionName);
    if (!style) {
      console.warn(`[3DMarkers] updateLineStyle: No style found for region ${regionName}`);
      return;
    }

    // Update resolved style
    style.line = { ...style.line, ...lineConfig };

    // Get current endpoints
    const endpoints = this.lineEndpoints.get(regionName);
    if (!endpoints) {
      console.warn(`[3DMarkers] updateLineStyle: No endpoints for region ${regionName}. Available:`, Array.from(this.lineEndpoints.keys()));
      return;
    }
    console.log(`[3DMarkers] updateLineStyle: Found endpoints for ${regionName}, recreating line`);

    // Remove old line and arrow
    const oldLine = this.lineMeshes.get(regionName);
    const oldArrow = this.arrowMeshes.get(regionName);

    if (oldLine) {
      this.markerGroup.remove(oldLine);
      oldLine.geometry.dispose();
      (oldLine.material as THREE.Material).dispose();
    }
    if (oldArrow) {
      this.markerGroup.remove(oldArrow);
      oldArrow.geometry.dispose();
      (oldArrow.material as THREE.Material).dispose();
      this.arrowMeshes.delete(regionName);
    }

    // Create new styled line
    const newLineConfig: Required<LineConfig> = {
      style: style.line.style ?? 'solid',
      curve: style.line.curve ?? 'straight',
      arrowHead: style.line.arrowHead ?? false,
      thickness: style.line.thickness ?? 2,
      length: style.line.length ?? this.config.lineLength,
    };

    const line = this.createStyledLine(
      endpoints.start,
      endpoints.end,
      newLineConfig,
      style.lineColor,
      0.9 * style.opacity,
      regionName
    );
    line.name = `line_${regionName}`;
    line.userData.annotation = regionName;

    // Preserve visibility from old line or sphere
    const sphere = this.markerMeshes.get(regionName);
    line.visible = sphere?.visible ?? true;

    this.markerGroup.add(line);
    this.lineMeshes.set(regionName, line);

    // For dashed/dotted lines, ensure line distances are computed after adding to scene
    if (newLineConfig.style === 'dashed' || newLineConfig.style === 'dotted') {
      line.computeLineDistances();
    }

    const mat = line.material as THREE.LineDashedMaterial;
    console.log(`[3DMarkers] updateLineStyle: Created new line for ${regionName}`, {
      style: newLineConfig.style,
      curve: newLineConfig.curve,
      arrowHead: newLineConfig.arrowHead,
      visible: line.visible,
      materialType: (line.material as THREE.Material).type,
      inScene: this.markerGroup.children.includes(line),
      childrenCount: this.markerGroup.children.length,
      color: mat.color?.getHexString(),
      opacity: mat.opacity,
      dashSize: 'dashSize' in mat ? mat.dashSize : 'N/A',
      gapSize: 'gapSize' in mat ? mat.gapSize : 'N/A',
      lineDistanceAttr: line.geometry.getAttribute('lineDistance')?.count ?? 0,
    });
  }

  /**
   * Update marker style for a specific region at runtime.
   */
  updateMarkerStyle(regionName: string, styleOverrides: Partial<MarkerStyleOverrides>): void {
    console.log(`[3DMarkers] updateMarkerStyle: region=${regionName}`, styleOverrides);
    const style = this.resolvedStyles.get(regionName);
    if (!style) {
      console.warn(`[3DMarkers] No resolved style for region: ${regionName}. Available regions:`, Array.from(this.resolvedStyles.keys()));
      return;
    }

    // Update resolved style
    if (styleOverrides.markerColor !== undefined) style.markerColor = styleOverrides.markerColor;
    if (styleOverrides.markerRadius !== undefined) style.markerRadius = styleOverrides.markerRadius;
    if (styleOverrides.lineColor !== undefined) style.lineColor = styleOverrides.lineColor;
    if (styleOverrides.opacity !== undefined) style.opacity = styleOverrides.opacity;
    if (styleOverrides.line) {
      style.line = { ...style.line, ...styleOverrides.line };
    }

    // Update sphere - use color.set() with new Color for reliable updates
    const sphere = this.markerMeshes.get(regionName);
    console.log(`[3DMarkers] Found sphere for ${regionName}:`, !!sphere, 'meshes keys:', Array.from(this.markerMeshes.keys()));
    if (sphere) {
      const mat = sphere.material as THREE.MeshBasicMaterial;
      console.log(`[3DMarkers] Setting sphere color to:`, style.markerColor?.toString(16));
      mat.color.set(new THREE.Color(style.markerColor));
      mat.opacity = 0.95 * style.opacity;
      mat.needsUpdate = true;
    }

    // Update line - use color.set() with new Color for reliable updates
    const line = this.lineMeshes.get(regionName);
    console.log(`[3DMarkers] Found line for ${regionName}:`, !!line);
    if (line) {
      const mat = line.material as THREE.LineBasicMaterial;
      mat.color.set(new THREE.Color(style.lineColor));
      mat.opacity = 0.9 * style.opacity;
      mat.needsUpdate = true;
    }

    // Update arrow - use color.set() with new Color for reliable updates
    const arrow = this.arrowMeshes.get(regionName);
    if (arrow) {
      const mat = arrow.material as THREE.MeshBasicMaterial;
      mat.color.set(new THREE.Color(style.lineColor));
      mat.opacity = style.opacity;
      mat.needsUpdate = true;
    }

    // If line config changed, rebuild the line
    if (styleOverrides.line) {
      this.updateLineStyle(regionName, styleOverrides.line);
    }
  }

  dispose(): void {
    this.domElement.removeEventListener('click', this.onClick);
    this.clear();
    this.scene.remove(this.markerGroup);
  }
}
