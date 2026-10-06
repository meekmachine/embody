import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import { annotationQuery } from './runtime';
import { observeAnnotationModel } from './modelObservation';
import * as THREE from 'three';
import { ThreeAnnotationController } from './ThreeAnnotationController';
import { ThreeAnnotationMarkers } from './ThreeAnnotationMarkers';
import { HtmlAnnotationMarkers } from './HtmlAnnotationMarkers';
import { CameraDOMControls } from './DOMControls';
import type {
  CharacterConfig,
  ThreeAnnotationControllerConfig,
  MarkerStyle,
  LineConfig,
  MarkerStyleOverrides,
  ExpandAnimation,
  ExpandedRegionState,
} from './types';

/**
 * ThreeAnnotations Configuration
 */
export interface ThreeAnnotationsConfig {
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
  cameraOptions?: Partial<ThreeAnnotationControllerConfig>;
}

/**
 * ThreeAnnotations - Camera & Marker System for Three.js
 *
 * Factory class that creates and manages camera controller and markers.
 *
 * @example
 * ```typescript
 * const annotations = await ThreeAnnotations.create({
 *   scene,
 *   camera,
 *   domElement: canvas,
 *   markerStyle: '3d',
 * });
 *
 * annotations.setModel(model);
 * await annotations.loadCharacter(config);
 * annotations.focus('head');
 *
 * // In render loop
 * annotations.update();
 * ```
 */
export class ThreeAnnotations {
  private readonly cameraController: ThreeAnnotationController;
  private model: THREE.Object3D | null = null;

  static async create(options: ThreeAnnotationsConfig): Promise<ThreeAnnotations> { await initEmbodyCore(); return new ThreeAnnotations(options); }

  constructor(options: ThreeAnnotationsConfig) {
    this.cameraController = new ThreeAnnotationController({
      scene: options.scene,
      camera: options.camera,
      domElement: options.domElement,
      showDOMControls: options.showControls ?? false,
      onRegionSelect: options.onRegionSelect,
      ...options.cameraOptions,
    });
    this.cameraController.setMarkersVisible(true);
    if (options.markerStyle) this.cameraController.setMarkerStyle(options.markerStyle);
  }

  setModel(model: THREE.Object3D): this {
    this.model = model;
    this.cameraController.setModel(model);
    return this;
  }

  async loadCharacter(config: CharacterConfig): Promise<this> {
    await this.cameraController.loadRegions(config);
    return this;
  }

  focus(regionName: string, duration?: number): Promise<void> { return this.cameraController.focusRegion(regionName, duration); }
  getRegions(): string[] { return this.cameraController.getRegionNames(); }
  getCurrentRegion(): string | null { return this.cameraController.getCurrentRegion(); }
  setMarkerStyle(style: MarkerStyle): this { this.cameraController.setMarkerStyle(style); return this; }
  setMarkersVisible(visible: boolean): this { this.cameraController.setMarkersVisible(visible); return this; }
  setControlsVisible(visible: boolean): this { this.cameraController.setDOMControlsVisible(visible); return this; }
  getCameraState() { return this.cameraController.getCameraState(); }
  setCameraState(position: [number, number, number], target: [number, number, number], _animate?: boolean): this {
    this.cameraController.setCameraState({ position, target }); return this;
  }
  get controller(): ThreeAnnotationController { return this.cameraController; }
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
  validateCharacter(expectedBones?: Record<string, string>, expectedMorphs?: string[]): CharacterValidationResult {
    return annotationQuery('validateCharacter', { model: this.model ? observeAnnotationModel(this.model) : null, expectedBones, expectedMorphs });
  }
  getBoneNames(): string[] { return annotationQuery('modelNames', { model: this.model ? observeAnnotationModel(this.model) : null, kind: 'bones' }); }
  getMorphNames(): string[] { return annotationQuery('modelNames', { model: this.model ? observeAnnotationModel(this.model) : null, kind: 'morphs' }); }
  getMeshNames(): string[] { return annotationQuery('modelNames', { model: this.model ? observeAnnotationModel(this.model) : null, kind: 'meshes' }); }
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
export { ThreeAnnotationController as CameraController } from './ThreeAnnotationController';
export { ThreeAnnotationMarkers as Markers3D } from './ThreeAnnotationMarkers';
export { HtmlAnnotationMarkers as MarkersHTML } from './HtmlAnnotationMarkers';
export { CameraDOMControls as Controls } from './DOMControls';
