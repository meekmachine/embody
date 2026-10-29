import * as THREE from 'three';
import { ThreeAnnotationController } from './ThreeAnnotationController';
import type { AnnotationAnchoredRegion, CharacterConfig, MarkerStyle, MarkerStyleOverrides, LineConfig, ExpandAnimation } from './types';
export interface AnnotationMarkersConfig { scene: THREE.Scene; camera: THREE.PerspectiveCamera; domElement: HTMLElement; onSelect: (name: string) => void; config?: Partial<MarkerStyleOverrides> & { lineLength?: number; labelScale?: number }; }
/** Marker-only native view of the same Rust runtime used by the controller. */
export class ThreeAnnotationMarkers {
  protected readonly controller: ThreeAnnotationController;
  constructor(private readonly options: AnnotationMarkersConfig, private readonly style: MarkerStyle = '3d') {
    this.controller = new ThreeAnnotationController({ ...options, onRegionSelect: options.onSelect, showDOMControls: false }, { captureInput: false, manageCamera: false, markerDefaults: options.config });
    this.controller.setMarkersVisible(true);
  }
  setModel(model: THREE.Object3D): void { this.controller.setModel(model); }
  loadRegions(config: CharacterConfig, options: { sliceSurfaceQueries?: boolean } = {}): Promise<void> {
    this.controller.prepareRegionsForReveal({ ...config, markerStyle: this.style, playIntroOnLoad: false, defaultRegion: undefined });
    return this.controller.loadMarkersForCurrentRegions(options.sliceSurfaceQueries);
  }
  setCurrentRegion(name: string | null): void { this.controller.setCurrentRegion(name); }
  updateRegion(name: string, update: Partial<AnnotationAnchoredRegion>): void { this.controller.updateAnnotationRegion(name, update); }
  removeRegion(name: string): void { this.controller.removeAnnotationRegion(name); }
  updateRegionMeshes(name: string, meshes: string[]): void { this.controller.updateRegionMeshes(name, meshes); }
  repositionMarker(name: string, position: THREE.Vector3): void { this.controller.repositionMarker(name, position); }
  getMarkerPosition(name: string): THREE.Vector3 | null { const p = this.controller.getMarkerPosition(name); return p ? new THREE.Vector3(p.x, p.y, p.z) : null; }
  updateLineStyle(name: string, line: Partial<LineConfig>): void { this.controller.setRegionLineStyle(name, line); }
  updateMarkerStyle(name: string, style: Partial<MarkerStyleOverrides>): void { this.controller.setRegionStyle(name, style); }
  setSoloMarker(name: string | null): void { this.controller.soloMarker(name); }
  getSoloedMarker(): string | null { return this.controller.getSoloedMarker(); }
  expandRegion(name: string, animation: ExpandAnimation = 'outward', duration?: number): void { this.controller.setRegionExpansion(name, true, animation, duration); }
  collapseRegion(name: string, duration?: number): void { this.controller.collapseRegion(name, duration); }
  toggleRegion(name: string, animation: ExpandAnimation = 'outward', duration?: number): void { this.controller.toggleRegion(name, animation, duration); }
  getExpandedRegions() { return this.controller.getExpandedRegions(); }
  update(): void { this.controller.update(); }
  setVisible(visible: boolean): void { this.controller.setMarkersVisible(visible); }
  clear(): void { this.controller.clearMarkers(); }
  dispose(): void { this.controller.dispose(); }
}
