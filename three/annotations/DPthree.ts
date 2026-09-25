import * as THREE from 'three';
import { DPthreeCameraController } from './DPthreeCameraController';
import { DPthree3DMarkers } from './DPthree3DMarkers';
import { DPthreeHTMLMarkers } from './DPthreeHTMLMarkers';
import { CameraDOMControls } from './DOMControls';
import type {
  CharacterConfig,
  DPthreeCameraControllerConfig,
  MarkerStyle,
  LineConfig,
  MarkerStyleOverrides,
  ExpandAnimation,
  ExpandedRegionState,
} from './types';

/**
 * DPthree Configuration
 */
export interface DPthreeConfig {
  /** Three.js scene */
  scene: THREE.Scene;
  /** Three.js camera */
  camera: THREE.PerspectiveCamera;
  /** Canvas or container element */
  domElement: HTMLElement;
  /** Marker style: '3d' (default) or 'html' */
  markerStyle?: MarkerStyle;
  /** Show DOM controls dropdown. Default: false */
  showControls?: boolean;
  /** Callback when a region is selected */
  onRegionSelect?: (name: string) => void;
  /** Camera controller options */
  cameraOptions?: Partial<DPthreeCameraControllerConfig>;
}

/**
 * DPthree - Camera & Marker System for Three.js
 *
 * Factory class that creates and manages camera controller and markers.
 *
 * @example
 * ```typescript
 * const dp = new DPthree({
 *   scene,
 *   camera,
 *   domElement: canvas,
 *   markerStyle: '3d',
 * });
 *
 * dp.setModel(model);
 * await dp.loadCharacter(config);
 * dp.focus('head');
 *
 * // In render loop
 * dp.update();
 * ```
 */
export class DPthree {
  private readonly cameraController: DPthreeCameraController;
  private markerStyle: MarkerStyle;
  private model: THREE.Object3D | null = null;

  constructor(options: DPthreeConfig) {
    this.markerStyle = options.markerStyle ?? '3d';
    this.cameraController = new DPthreeCameraController({
      scene: options.scene,
      camera: options.camera,
      domElement: options.domElement,
      showDOMControls: options.showControls ?? false,
      onRegionSelect: options.onRegionSelect,
      ...options.cameraOptions,
    });
    this.cameraController.setMarkersVisible(true);
  }

  setModel(model: THREE.Object3D): this {
    this.model = model;
    this.cameraController.setModel(model);
    return this;
  }

  async loadCharacter(config: CharacterConfig): Promise<this> {
    this.markerStyle = config.markerStyle ?? this.markerStyle;
    await this.cameraController.loadRegions({ ...config, markerStyle: this.markerStyle });
    return this;
  }

  focus(regionName: string, duration?: number): Promise<void> { return this.cameraController.focusRegion(regionName, duration); }
  getRegions(): string[] { return this.cameraController.getRegionNames(); }
  getCurrentRegion(): string | null { return this.cameraController.getCurrentRegion(); }
  setMarkerStyle(style: MarkerStyle): this { this.markerStyle = style; this.cameraController.setMarkerStyle(style); return this; }
  setMarkersVisible(visible: boolean): this { this.cameraController.setMarkersVisible(visible); return this; }
  setControlsVisible(visible: boolean): this { this.cameraController.setDOMControlsVisible(visible); return this; }
  getCameraState() { return this.cameraController.getCameraState(); }
  setCameraState(position: [number, number, number], target: [number, number, number], _animate?: boolean): this {
    this.cameraController.setCameraState({ position, target }); return this;
  }
  get controller(): DPthreeCameraController { return this.cameraController; }
  update(): void { this.cameraController.update(); }
  expandRegion(name: string, duration?: number): this { this.cameraController.expandRegion(name, duration); return this; }
  collapseRegion(name: string, duration?: number): this { this.cameraController.collapseRegion(name, duration); return this; }
  toggleRegion(name: string, animation: ExpandAnimation = 'outward', duration?: number): this { this.cameraController.toggleRegion(name, animation, duration); return this; }
  getExpandedRegions(): ExpandedRegionState[] { return this.cameraController.getExpandedRegions(); }
  soloMarker(name: string | null): this { this.cameraController.soloMarker(name); return this; }
  getSoloedMarker(): string | null { return this.cameraController.getSoloedMarker(); }
  setRegionLineStyle(name: string, line: Partial<LineConfig>): this { this.cameraController.setRegionLineStyle(name, line); return this; }
  setRegionStyle(name: string, style: Partial<MarkerStyleOverrides>): this { this.cameraController.setRegionStyle(name, style); return this; }
  dispose(): void { this.cameraController.dispose(); this.model = null; }

  // ============ CHARACTER VALIDATION ============

  /**
   * Validate a loaded character model against expected bone/morph mappings
   * @param expectedBones - Map of semantic bone names to actual bone names
   * @param expectedMorphs - List of expected morph target names
   * @returns Validation result with found/missing bones and morphs
   */
  validateCharacter(
    expectedBones?: Record<string, string>,
    expectedMorphs?: string[]
  ): CharacterValidationResult {
    if (!this.model) {
      return {
        valid: false,
        bones: { found: [], missing: [], unexpected: [] },
        morphs: { found: [], missing: [], unexpected: [] },
        meshes: { found: [], total: 0 },
        summary: 'No model loaded',
      };
    }

    // Collect actual bones and morphs from model
    const actualBones: string[] = [];
    const actualMorphs: Map<string, string[]> = new Map(); // meshName -> morphNames
    const meshNames: string[] = [];

    this.model.traverse((obj) => {
      if ((obj as THREE.Bone).isBone) {
        actualBones.push(obj.name);
      }
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        meshNames.push(mesh.name);
        if (mesh.morphTargetDictionary) {
          actualMorphs.set(mesh.name, Object.keys(mesh.morphTargetDictionary));
        }
      }
    });

    // Flatten morph names
    const allActualMorphs = new Set<string>();
    actualMorphs.forEach((morphs) => morphs.forEach((m) => allActualMorphs.add(m)));

    // Compare bones
    const boneResult: ValidationCategory = { found: [], missing: [], unexpected: [] };
    const expectedBoneNames = new Set(expectedBones ? Object.values(expectedBones) : []);
    const actualBoneSet = new Set(actualBones);

    if (expectedBones) {
      for (const [semantic, boneName] of Object.entries(expectedBones)) {
        if (actualBoneSet.has(boneName)) {
          boneResult.found.push({ name: boneName, semantic });
        } else {
          boneResult.missing.push({ name: boneName, semantic });
        }
      }
    }

    // Find unexpected bones (bones in model not in expected mapping)
    for (const bone of actualBones) {
      if (!expectedBoneNames.has(bone)) {
        boneResult.unexpected.push({ name: bone });
      }
    }

    // Compare morphs
    const morphResult: ValidationCategory = { found: [], missing: [], unexpected: [] };
    const expectedMorphSet = new Set(expectedMorphs || []);

    if (expectedMorphs) {
      for (const morphName of expectedMorphs) {
        if (allActualMorphs.has(morphName)) {
          morphResult.found.push({ name: morphName });
        } else {
          morphResult.missing.push({ name: morphName });
        }
      }
    }

    // Find unexpected morphs
    for (const morph of allActualMorphs) {
      if (!expectedMorphSet.has(morph)) {
        morphResult.unexpected.push({ name: morph });
      }
    }

    // Calculate validity
    const bonesValid = boneResult.missing.length === 0;
    const morphsValid = morphResult.missing.length === 0;
    const valid = bonesValid && morphsValid;

    // Generate summary
    const summaryParts: string[] = [];
    if (boneResult.missing.length > 0) {
      summaryParts.push(`${boneResult.missing.length} missing bones`);
    }
    if (morphResult.missing.length > 0) {
      summaryParts.push(`${morphResult.missing.length} missing morphs`);
    }
    if (boneResult.unexpected.length > 0) {
      summaryParts.push(`${boneResult.unexpected.length} extra bones`);
    }
    if (morphResult.unexpected.length > 0) {
      summaryParts.push(`${morphResult.unexpected.length} extra morphs`);
    }

    const summary = valid
      ? `Valid: ${boneResult.found.length} bones, ${morphResult.found.length} morphs`
      : summaryParts.join(', ');

    return {
      valid,
      bones: boneResult,
      morphs: morphResult,
      meshes: { found: meshNames, total: meshNames.length },
      summary,
    };
  }

  /**
   * Get all bone names in the loaded model
   */
  getBoneNames(): string[] {
    const bones: string[] = [];
    this.model?.traverse((obj) => {
      if ((obj as THREE.Bone).isBone) {
        bones.push(obj.name);
      }
    });
    return bones;
  }

  /**
   * Get all morph target names in the loaded model
   */
  getMorphNames(): string[] {
    const morphs = new Set<string>();
    this.model?.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        if (mesh.morphTargetDictionary) {
          Object.keys(mesh.morphTargetDictionary).forEach((m) => morphs.add(m));
        }
      }
    });
    return Array.from(morphs);
  }

  /**
   * Get all mesh names in the loaded model
   */
  getMeshNames(): string[] {
    const meshes: string[] = [];
    this.model?.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        meshes.push(obj.name);
      }
    });
    return meshes;
  }
}

// ============ VALIDATION TYPES ============

export interface ValidationItem {
  name: string;
  semantic?: string;
}

export interface ValidationCategory {
  found: ValidationItem[];
  missing: ValidationItem[];
  unexpected: ValidationItem[];
}

export interface CharacterValidationResult {
  valid: boolean;
  bones: ValidationCategory;
  morphs: ValidationCategory;
  meshes: { found: string[]; total: number };
  summary: string;
}

// Re-export for convenience
export { DPthreeCameraController as CameraController } from './DPthreeCameraController';
export { DPthree3DMarkers as Markers3D } from './DPthree3DMarkers';
export { DPthreeHTMLMarkers as MarkersHTML } from './DPthreeHTMLMarkers';
export { CameraDOMControls as Controls } from './DOMControls';
