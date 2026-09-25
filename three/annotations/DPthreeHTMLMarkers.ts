import { boneResolutionProfile } from './boneResolutionProfile';
import type {
  Region,
  CharacterConfig,
  ExpandAnimation,
  ExpandedRegionState,
  AnnotationAnchoredRegion,
} from './types';
import {
  detectAnnotationLaterality,
  fuzzyNameMatch,
  getDefaultAnnotationLaterality,
  getModelLocalOrbitAngle,
  getSemanticHorizontalSignForSide,
  passesMarkerCameraAngleGate,
  resolveBoneNames,
  resolveFaceCenter,
  resolveRegionVisibilityCameraAngle,
  type AnnotationLaterality,
} from './adapter';
import * as THREE from 'three';
import { AnimationFrameTaskScheduler } from './animationFrameTaskScheduler';
import {
  resolveMarkerAnchorRegion,
  shouldUseFaceCenterForMarkerAnchor,
} from './annotationAnchorModel';
import {
  getRuntimeAUMorphAnchorPoint,
  getRuntimeAnnotationSide,
  getRuntimeAUMeshSideOffset,
} from './runtimeAnnotationSidePreview';

const HTML_VISIBILITY_ANIMATION_KEY = 'html-marker-layer';

interface FaceCenterCacheEntry {
  center: THREE.Vector3;
  headBone: THREE.Object3D | null;
  headBoneLocalOffset: THREE.Vector3 | null;
}

function getAnnotationRegionLabel(region: Region): string | undefined {
  const label = (region as AnnotationAnchoredRegion).label;
  if (typeof label !== 'string') return undefined;
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatFallbackRegionLabel(name: string): string {
  return name.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * HTML overlay markers with GPU-based occlusion via 3D proxy points.
 *
 * Architecture:
 * 1. Each HTML marker has a corresponding invisible 3D mesh in the scene
 * 2. The 3D mesh uses onBeforeRender callback to notify visibility
 * 3. When the mesh renders (passes depth test), it updates the HTML marker position
 * 4. When occluded, the callback doesn't fire, so we track "was rendered this frame"
 *
 * Performance: No per-frame visibility calculations - GPU depth testing determines
 * visibility, and we only update HTML when the 3D proxy actually renders.
 */
export class DPthreeHTMLMarkers {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private domElement: HTMLElement;
  private model: THREE.Object3D | null = null;
  private regions: Region[] = [];
  private currentRegion: string | null = null;
  private onSelect: (name: string) => void;
  private characterConfig: CharacterConfig | null = null;

  // HTML layer
  private labelsContainer: HTMLDivElement;
  private markers: Map<string, HTMLDivElement> = new Map();

  // 3D occlusion proxies
  private occlusionGroup: THREE.Group;
  private occlusionMeshes: Map<string, THREE.Mesh> = new Map();

  // Track which markers were rendered this frame
  private renderedThisFrame: Set<string> = new Set();
  private frameId = 0;
  private markerFrameIds: Map<string, number> = new Map();
  private visibilityAnimationActive = false;
  private readonly visibilityAnimationScheduler = new AnimationFrameTaskScheduler();
  private visibilityAnimationToken = 0;

  // Model bounds
  private modelCenter = new THREE.Vector3();
  private modelSize = new THREE.Vector3();
  private autoCollapseThreshold = 2.0; // Calculated from model size
  private lastCameraDistance = -1; // Cache to detect zoom-out

  // Cached viewport size for marker positioning
  private viewportSize: { width: number; height: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Expanding anchors state
  private expandedRegions: Map<string, boolean> = new Map();
  private parentChildIndex: Map<string, string[]> = new Map(); // parent -> children
  private childParentIndex: Map<string, string> = new Map(); // child -> parent
  private hiddenChildren: Set<string> = new Set(); // Children that should be hidden

  // Cache face center results per marker to avoid expensive recomputation every frame.
  private faceCenterCache: Map<string, FaceCenterCacheEntry> = new Map();
  private laterality: AnnotationLaterality = getDefaultAnnotationLaterality();

  constructor(config: {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    domElement: HTMLElement;
    onSelect: (name: string) => void;
  }) {
    this.scene = config.scene;
    this.camera = config.camera;
    this.domElement = config.domElement;
    this.onSelect = config.onSelect;

    // Create group for occlusion proxies
    this.occlusionGroup = new THREE.Group();
    this.occlusionGroup.name = 'DPthreeHTMLMarkers_Occlusion';
    this.scene.add(this.occlusionGroup);

    // Create container for HTML markers
    this.labelsContainer = document.createElement('div');
    this.labelsContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: hidden;
      transform-origin: center center;
      will-change: opacity, transform;
      opacity: 1;
      transform: scale(1);
    `;

    const parent = this.domElement.parentElement;
    if (parent) {
      const style = window.getComputedStyle(parent);
      if (style.position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(this.labelsContainer);
    }

    this.updateViewportSize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateViewportSize();
      });
      this.resizeObserver.observe(this.domElement);
    }
  }

  setModel(model: THREE.Object3D): void {
    this.model = model;
    this.faceCenterCache.clear(); // Clear cache when model changes
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    box.getCenter(this.modelCenter);
    box.getSize(this.modelSize);

    // Auto-collapse threshold: 2.5x model height - collapse when zoomed out this far
    this.autoCollapseThreshold = this.modelSize.y * 2.5;
    this.lastCameraDistance = -1; // Reset to force recalculation
    this.refreshLaterality();
  }

  loadRegions(config: CharacterConfig): void {
    this.clear();
    this.regions = config.regions ?? [];
    this.characterConfig = config;
    this.refreshLaterality();

    // Build parent/child index
    this.parentChildIndex.clear();
    this.childParentIndex.clear();
    this.hiddenChildren.clear();
    for (const region of (config.regions ?? [])) {
      if (region.children && region.children.length > 0) {
        this.parentChildIndex.set(region.name, region.children);
        for (const childName of region.children) {
          this.childParentIndex.set(childName, region.name);
          this.hiddenChildren.add(childName); // Children start hidden
        }
      }
    }

    (config.regions ?? []).forEach((region, index) => {
      this.createMarker(region, index + 1);
    });
  }

  setCurrentRegion(name: string | null): void {
    this.currentRegion = name;
    this.updateMarkerStyles();
  }

  /**
   * Update a region's configuration and recreate its marker.
   * This is the general method for updating any region properties.
   *
   * @param regionName - Name of the region to update
   * @param update - Partial region config to merge with existing config
   */
  updateRegion(regionName: string, update: Partial<Region>): void {
    console.log(`[HTMLMarkers] updateRegion: ${regionName}`, update);

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
      this.faceCenterCache.delete(regionName);
      this.createMarker(newRegion, this.regions.length);
      console.log(`[HTMLMarkers] Region "${regionName}" marker created`);
      return;
    }

    // Merge update with existing region config
    this.regions[regionIndex] = {
      ...this.regions[regionIndex],
      ...update,
    };

    // Update characterConfig if it exists
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
    this.faceCenterCache.delete(regionName);

    // Remove and recreate the marker
    this.removeMarkerComponents(regionName);

    // Recreate marker with new position
    const region = this.regions[regionIndex];
    this.createMarker(region, regionIndex + 1);

    console.log(`[HTMLMarkers] Region "${regionName}" marker recreated with updated config`);
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

    this.parentChildIndex.delete(regionName);
    this.childParentIndex.delete(regionName);
    this.hiddenChildren.delete(regionName);
    this.removeMarkerComponents(regionName);
  }

  /**
   * Remove all marker components for a region
   */
  private removeMarkerComponents(regionName: string): void {
    const oldMarker = this.markers.get(regionName);
    if (oldMarker) {
      oldMarker.remove();
      this.markers.delete(regionName);
    }

    const oldOcclusionMesh = this.occlusionMeshes.get(regionName);
    if (oldOcclusionMesh) {
      oldOcclusionMesh.onBeforeRender = () => {}; // Clear callback
      this.occlusionGroup.remove(oldOcclusionMesh);
      if (oldOcclusionMesh.geometry) oldOcclusionMesh.geometry.dispose();
      if (oldOcclusionMesh.material) (oldOcclusionMesh.material as THREE.Material).dispose();
      this.occlusionMeshes.delete(regionName);
    }

    this.markerFrameIds.delete(regionName);
    this.faceCenterCache.delete(regionName);
  }

  updateRegionMeshes(regionName: string, meshNames: string[]): void {
    console.log(`[HTMLMarkers] updateRegionMeshes: ${regionName} -> ${meshNames.join(', ')}`);
    this.updateRegion(regionName, { meshes: meshNames });
  }

  /**
   * Reposition an existing marker to a new position.
   */
  repositionMarker(regionName: string, newPosition: THREE.Vector3): void {
    console.log(`[HTMLMarkers] repositionMarker: ${regionName} -> (${newPosition.x.toFixed(3)}, ${newPosition.y.toFixed(3)}, ${newPosition.z.toFixed(3)})`);

    const occlusionMesh = this.occlusionMeshes.get(regionName);
    if (occlusionMesh) {
      occlusionMesh.position.copy(newPosition);
      occlusionMesh.userData.position = newPosition.clone();
    }
  }

  /**
   * Get the current position of a marker.
   */
  getMarkerPosition(regionName: string): THREE.Vector3 | null {
    const occlusionMesh = this.occlusionMeshes.get(regionName);
    return occlusionMesh ? occlusionMesh.position.clone() : null;
  }

  private updateViewportSize(): void {
    const width = this.domElement.clientWidth || this.domElement.offsetWidth;
    const height = this.domElement.clientHeight || this.domElement.offsetHeight;

    if (width > 0 && height > 0) {
      this.viewportSize = { width, height };
      return;
    }

    const rect = this.domElement.getBoundingClientRect();
    this.viewportSize = { width: rect.width, height: rect.height };
  }

  private getViewportSize(): { width: number; height: number } {
    if (!this.viewportSize) {
      this.updateViewportSize();
    }

    return this.viewportSize ?? { width: 0, height: 0 };
  }

  private setMarkerDisplay(marker: HTMLDivElement, visible: boolean): void {
    const nextDisplay = visible ? 'flex' : 'none';
    if (marker.style.display !== nextDisplay) {
      marker.style.display = nextDisplay;
    }
  }

  private setMarkerScale(marker: HTMLDivElement, scale: number): void {
    marker.style.setProperty('--marker-scale', `${scale}`);
  }

  private setMarkerScreenPosition(marker: HTMLDivElement, x: number, y: number): void {
    marker.style.setProperty('--marker-x', `${x}px`);
    marker.style.setProperty('--marker-y', `${y}px`);
  }

  private createMarker(region: Region, number: number): void {
    if (!this.model) return;

    const position = this.getRegionCenter(region);
    if (!position) return;
    const visibilityCameraAngle = resolveRegionVisibilityCameraAngle(region, this.laterality);

    const name = region.name;
    const hasChildren = region.children && region.children.length > 0;

    // Create 3D occlusion proxy mesh
    // This mesh is tiny and invisible but participates in depth testing
    // When it renders, it notifies the HTML marker to show
    const occlusionMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.005, 4, 4),
      new THREE.MeshBasicMaterial({
        color: 0xff0000,
        transparent: true,
        opacity: 0, // Invisible
        depthTest: true,
        depthWrite: false,
      })
    );
    occlusionMesh.position.copy(position);
    occlusionMesh.name = `occlusion_${name}`;
    occlusionMesh.frustumCulled = true;

    // Store region data for visibility checks
    occlusionMesh.userData.regionName = name;
    occlusionMesh.userData.cameraAngle = visibilityCameraAngle;
    occlusionMesh.userData.position = position.clone();

    // This callback fires when the mesh is about to render (passed frustum + depth)
    occlusionMesh.onBeforeRender = () => {
      this.onProxyRendered(name, occlusionMesh);
    };

    this.occlusionGroup.add(occlusionMesh);
    this.occlusionMeshes.set(name, occlusionMesh);

    // Create HTML marker
    const marker = document.createElement('div');
    marker.className = 'annotation-html-marker';
    marker.dataset.annotation = name;
    marker.title = getAnnotationRegionLabel(region) ?? formatFallbackRegionLabel(name);
    marker.setAttribute('aria-label', marker.title);
    // Show + for parent markers, number for leaf markers
    marker.innerHTML = `<span>${hasChildren ? '+' : number}</span>`;
    marker.style.cssText = `
      position: absolute;
      --marker-x: 0px;
      --marker-y: 0px;
      --marker-scale: 1;
      transform: translate3d(var(--marker-x), var(--marker-y), 0) translate(-50%, -50%) scale(var(--marker-scale));
      pointer-events: auto;
      cursor: pointer;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: rgba(66, 153, 225, 0.9);
      border: 2px solid white;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      display: none;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      font-weight: bold;
      color: white;
      transition: transform 0.15s ease, background 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease;
      z-index: 100;
    `;

    marker.addEventListener('mouseenter', () => {
      this.setMarkerScale(marker, 1.2);
      marker.style.background = 'rgba(99, 179, 237, 1)';
    });
    marker.addEventListener('mouseleave', () => {
      if (this.currentRegion !== name) {
        this.setMarkerScale(marker, 1);
        marker.style.background = 'rgba(66, 153, 225, 0.9)';
      }
    });
    marker.addEventListener('click', (e) => {
      e.stopPropagation();

      // If this is a parent region with children, toggle expand/collapse
      const children = this.parentChildIndex.get(name);
      if (children && children.length > 0) {
        const regionDef = this.regions.find(r => r.name === name);
        const animation = regionDef?.expandAnimation || 'staggered';
        this.toggleRegion(name, animation);
      }

      this.onSelect(name);
    });

    this.labelsContainer.appendChild(marker);
    this.markers.set(name, marker);
  }

  /**
   * Called when a 3D proxy mesh is about to render.
   * This means it passed frustum culling and depth test - it's visible!
   */
  private onProxyRendered(name: string, mesh: THREE.Mesh): void {
    const marker = this.markers.get(name);
    if (!marker) return;

    // Check if this is a hidden child (parent not expanded)
    if (this.hiddenChildren.has(name)) {
      this.setMarkerDisplay(marker, false);
      return;
    }

    // Check explicit cameraAngle visibility
    const cameraAngle = mesh.userData.cameraAngle;
    if (cameraAngle !== undefined && cameraAngle !== 0) {
      const currentAngle = getModelLocalOrbitAngle(this.model, this.modelCenter, this.camera.position);
      if (!passesMarkerCameraAngleGate({ markerAngle: cameraAngle, currentCameraAngle: currentAngle })) {
        this.setMarkerDisplay(marker, false);
        return;
      }
    }

    // Mark as rendered this frame
    this.markerFrameIds.set(name, this.frameId);

    const viewportSize = this.getViewportSize();

    // Project 3D position to screen
    const pos = mesh.userData.position as THREE.Vector3;
    const screenPos = pos.clone().project(this.camera);

    // Behind camera check
    if (screenPos.z > 1) {
      this.setMarkerDisplay(marker, false);
      return;
    }

    // Convert to CSS coordinates
    const x = (screenPos.x * 0.5 + 0.5) * viewportSize.width;
    const y = (-screenPos.y * 0.5 + 0.5) * viewportSize.height;

    this.setMarkerDisplay(marker, true);
    this.setMarkerScreenPosition(marker, x, y);
  }

  private getSuffixPattern(): string | undefined {
    return this.characterConfig?.suffixPattern;
  }

  /**
   * Get center point of a region's bones/meshes.
   * Uses fuzzy matching to handle bone names with numeric suffixes.
   * For face regions, uses resolveFaceCenter with auto-detection by morph count.
   */
  private getRegionCenter(region: Region): THREE.Vector3 | null {
    if (!this.model) return null;

    const resolvedAnchor = resolveMarkerAnchorRegion(region);
    const anchorRegion = resolvedAnchor.region;
    this.model.updateMatrixWorld(true);

    // PRIORITY 0: Custom position override
    if (anchorRegion.customPosition) {
      return new THREE.Vector3(
        anchorRegion.customPosition.x,
        anchorRegion.customPosition.y,
        anchorRegion.customPosition.z
      );
    }

    // PRIORITY 1: For face regions, use cached face center to avoid expensive recomputation
    const isFaceRegion = shouldUseFaceCenterForMarkerAnchor(resolvedAnchor);

    if (isFaceRegion) {
      const cacheKey = anchorRegion.name;
      let cachedFaceCenter = this.faceCenterCache.get(cacheKey);

      // Initialize cache on first call
      if (!cachedFaceCenter) {
        const faceCenterResult = resolveFaceCenter(this.model as any, anchorRegion as any, boneResolutionProfile(this.characterConfig) ?? undefined);

        // Find head bone for tracking animated position
        const headBones: THREE.Object3D[] = [];
        const headBoneNames = resolveBoneNames(anchorRegion.bones, boneResolutionProfile(this.characterConfig))
          .filter((name) => name.toLowerCase().includes('head'));
        this.model.traverse((obj) => {
          if (headBones.length === 0 && headBoneNames.some((name) => fuzzyNameMatch(obj.name, name, this.getSuffixPattern()))) {
            headBones.push(obj);
          }
        });

        const headBone = headBones[0] ?? null;
        const center = new THREE.Vector3(
          faceCenterResult.center.x,
          faceCenterResult.center.y,
          faceCenterResult.center.z
        );
        const headBoneLocalOffset = headBone
          ? headBone.worldToLocal(center.clone())
          : null;

        cachedFaceCenter = {
          center,
          headBone,
          headBoneLocalOffset,
        };
        this.faceCenterCache.set(cacheKey, cachedFaceCenter);
      }

      // If we have a head bone, use its current world position for animated models
      if (cachedFaceCenter.headBone && cachedFaceCenter.headBoneLocalOffset) {
        return cachedFaceCenter.headBone.localToWorld(
          cachedFaceCenter.headBoneLocalOffset.clone()
        );
      }

      // Otherwise return cached center
      return cachedFaceCenter.center.clone();
    }

    // Standard bone/mesh positioning for non-face regions
    const box = new THREE.Box3();
    let hasObjects = false;
    let usedRuntimeMorphAnchor = false;

    if (anchorRegion.objects?.includes('*')) {
      box.expandByObject(this.model);
      hasObjects = true;
    } else {
    if (anchorRegion.bones) {
      const resolvedBoneNames = resolveBoneNames(anchorRegion.bones, boneResolutionProfile(this.characterConfig));
      for (const boneName of resolvedBoneNames) {
        this.model.traverse((obj) => {
          if (fuzzyNameMatch(obj.name, boneName, this.getSuffixPattern())) {
            const worldPos = new THREE.Vector3();
            obj.getWorldPosition(worldPos);
            box.expandByPoint(worldPos);
            hasObjects = true;
          }
          });
        }
      }

    if (anchorRegion.meshes) {
      for (const meshName of anchorRegion.meshes) {
        this.model.traverse((obj) => {
          if (fuzzyNameMatch(obj.name, meshName, this.getSuffixPattern()) && (obj as THREE.Mesh).isMesh) {
            const runtimeMorphAnchorPoint = getRuntimeAUMorphAnchorPoint(
              anchorRegion as AnnotationAnchoredRegion,
              obj as THREE.Mesh,
            );
            if (runtimeMorphAnchorPoint) {
              box.expandByPoint(runtimeMorphAnchorPoint);
              usedRuntimeMorphAnchor = true;
            } else {
              box.expandByObject(obj);
            }
            hasObjects = true;
          }
        });
      }
      }
    }

    if (!hasObjects || box.isEmpty()) return null;

    const center = new THREE.Vector3();
    box.getCenter(center);
    const runtimeSide = getRuntimeAnnotationSide(anchorRegion);
    const runtimeSideSign = runtimeSide === 'left'
      ? getSemanticHorizontalSignForSide('left', this.laterality)
      : runtimeSide === 'right'
        ? getSemanticHorizontalSignForSide('right', this.laterality)
        : 0;
    const runtimeSideOffset = runtimeSideSign && !usedRuntimeMorphAnchor
      ? getRuntimeAUMeshSideOffset(anchorRegion, runtimeSideSign, this.modelSize)
      : null;
    if (runtimeSideOffset) {
      const modelRotation = new THREE.Matrix4();
      modelRotation.extractRotation(this.model.matrixWorld);
      center.add(runtimeSideOffset.applyMatrix4(modelRotation));
    }
    return center;
  }

  private updateMarkerStyles(): void {
    for (const [name, element] of this.markers) {
      const isSelected = name === this.currentRegion;
      if (isSelected) {
        this.setMarkerScale(element, 1.3);
        element.style.background = 'rgba(99, 179, 237, 1)';
        element.style.boxShadow = '0 0 12px rgba(66, 153, 225, 0.8)';
      } else {
        this.setMarkerScale(element, 1);
        element.style.background = 'rgba(66, 153, 225, 0.9)';
        element.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
      }
    }
  }

  /**
   * Call at start of each frame to reset state and update positions.
   * The onBeforeRender callbacks handle showing visible markers.
   * This method hides markers that didn't render.
   */
  update(): void {
    if (!this.model) return;

    // When HTML markers are hidden, skip all per-frame DOM and bone work.
    if (!this.occlusionGroup.visible) {
      return;
    }

    // Increment frame counter
    this.frameId++;
    if (!this.resizeObserver) {
      this.updateViewportSize();
    }

    // Check camera distance for auto-collapse
    const dx = this.camera.position.x - this.modelCenter.x;
    const dy = this.camera.position.y - this.modelCenter.y;
    const dz = this.camera.position.z - this.modelCenter.z;
    const cameraDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Only check threshold if distance changed significantly
    const distanceChanged = this.lastCameraDistance < 0 ||
      Math.abs(cameraDistance - this.lastCameraDistance) > this.lastCameraDistance * 0.05;

    if (distanceChanged) {
      const previousDistance = this.lastCameraDistance;
      this.lastCameraDistance = cameraDistance;

      // Auto-collapse only when crossing the threshold to avoid immediate re-collapse.
      const crossedAutoCollapseThreshold =
        previousDistance >= 0 &&
        previousDistance <= this.autoCollapseThreshold &&
        cameraDistance > this.autoCollapseThreshold;
      if (crossedAutoCollapseThreshold) {
        this.collapseAllRegions();
      }
    }

    // Update occlusion mesh positions (for animated models)
    for (const [name, mesh] of this.occlusionMeshes) {
      const region = this.regions.find(r => r.name === name);
      if (region) {
        const newPos = this.getRegionCenter(region);
        if (newPos) {
          mesh.position.copy(newPos);
          mesh.userData.position = newPos.clone();
        }
      }
    }

    // Hide markers that didn't render last frame (occluded)
    for (const [name, marker] of this.markers) {
      const lastFrame = this.markerFrameIds.get(name) || 0;
      // If marker wasn't rendered in the previous frame, hide it
      // Use frameId - 1 because onBeforeRender for current frame hasn't fired yet
      if (lastFrame < this.frameId - 1) {
        this.setMarkerDisplay(marker, false);
      }
    }
  }

  setVisible(visible: boolean): void {
    this.animateVisibility(visible);
  }

  private stopVisibilityAnimation(): void {
    this.visibilityAnimationScheduler.cancel(HTML_VISIBILITY_ANIMATION_KEY);
    this.visibilityAnimationActive = false;
    this.visibilityAnimationToken += 1;
  }

  private animateVisibility(visible: boolean): void {
    this.stopVisibilityAnimation();

    const wasVisible = this.labelsContainer.style.display !== 'none';
    if (visible) {
      this.labelsContainer.style.display = 'block';
      if (!wasVisible) {
        this.labelsContainer.style.opacity = '0';
        this.labelsContainer.style.transform = 'scale(0.92)';
      }
      this.occlusionGroup.visible = true;
    } else {
      this.occlusionGroup.visible = false;
    }

    const token = this.visibilityAnimationToken;
    const parsedStartOpacity = Number.parseFloat(window.getComputedStyle(this.labelsContainer).opacity || '1');
    const startOpacity = Number.isFinite(parsedStartOpacity) ? parsedStartOpacity : 1;
    const startScale = Number.parseFloat(
      this.labelsContainer.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? '1',
    ) || 1;
    const startTime = performance.now();
    const duration = 160;
    const targetOpacity = visible ? 1 : 0;
    const targetScale = visible ? 1 : 0.92;

    this.visibilityAnimationActive = true;
    this.visibilityAnimationScheduler.schedule(HTML_VISIBILITY_ANIMATION_KEY, (now): boolean => {
      if (token !== this.visibilityAnimationToken) return false;

      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      const eased = visible
        ? 1 - Math.pow(1 - t, 3)
        : t * t * (3 - 2 * t);

      const opacity = startOpacity + (targetOpacity - startOpacity) * eased;
      const scale = startScale + (targetScale - startScale) * eased;
      this.labelsContainer.style.opacity = `${opacity}`;
      this.labelsContainer.style.transform = `scale(${scale})`;

      if (t < 1) {
        return true;
      }

      this.visibilityAnimationActive = false;
      if (!visible) {
        this.labelsContainer.style.display = 'none';
      }
      this.labelsContainer.style.opacity = visible ? '1' : '0';
      this.labelsContainer.style.transform = 'scale(1)';
      return false;
    });
  }

  clear(): void {
    this.stopVisibilityAnimation();
    this.labelsContainer.style.display = 'block';
    this.labelsContainer.style.opacity = '1';
    this.labelsContainer.style.transform = 'scale(1)';
    // Clear HTML markers
    for (const element of this.markers.values()) {
      element.remove();
    }
    this.markers.clear();

    // Clear occlusion meshes
    while (this.occlusionGroup.children.length > 0) {
      const child = this.occlusionGroup.children[0];
      const mesh = child as THREE.Mesh;
      mesh.onBeforeRender = () => {}; // Clear callback
      this.occlusionGroup.remove(child);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) (mesh.material as THREE.Material).dispose();
    }
    this.occlusionMeshes.clear();
    this.markerFrameIds.clear();
    this.faceCenterCache.clear();
    this.expandedRegions.clear();
    this.parentChildIndex.clear();
    this.childParentIndex.clear();
    this.hiddenChildren.clear();
  }

  // ============ EXPANDING ANCHORS ============

  /**
   * Expand a parent region to show its children.
   */
  expandRegion(regionName: string, animation: ExpandAnimation = 'outward', duration = 400): void {
    const children = this.parentChildIndex.get(regionName);
    if (!children || children.length === 0) return;

    // Already expanded
    if (this.expandedRegions.get(regionName)) return;

    this.expandedRegions.set(regionName, true);

    // Update parent marker to show minus sign
    const parentMarker = this.markers.get(regionName);
    if (parentMarker) {
      parentMarker.innerHTML = '<span>−</span>'; // minus sign
    }

    // Show children with animation
    const staggerDelay = animation === 'staggered' ? 50 : 0;

    children.forEach((childName, index) => {
      setTimeout(() => {
        this.hiddenChildren.delete(childName);
        const marker = this.markers.get(childName);
        if (marker) {
          // Animate in with CSS
          marker.style.transition = `transform ${duration}ms ease-out, opacity ${duration}ms ease-out`;
          this.setMarkerScale(marker, 0);
          marker.style.opacity = '0';
          this.setMarkerDisplay(marker, true);
          requestAnimationFrame(() => {
            this.setMarkerScale(marker, 1);
            marker.style.opacity = '1';
          });
        }
      }, index * staggerDelay);
    });
  }

  /**
   * Collapse a parent region to hide its children.
   */
  collapseRegion(regionName: string, duration = 300): void {
    const children = this.parentChildIndex.get(regionName);
    if (!children || children.length === 0) return;

    // Already collapsed
    if (!this.expandedRegions.get(regionName)) return;

    this.expandedRegions.set(regionName, false);

    // Update parent marker to show plus sign
    const parentMarker = this.markers.get(regionName);
    if (parentMarker) {
      parentMarker.innerHTML = '<span>+</span>';
    }

    // Hide children with animation
    for (const childName of children) {
      const marker = this.markers.get(childName);
      if (marker) {
        marker.style.transition = `transform ${duration}ms ease-in, opacity ${duration}ms ease-in`;
        this.setMarkerScale(marker, 0);
        marker.style.opacity = '0';
      }

      // Mark as hidden after animation
      setTimeout(() => {
        this.hiddenChildren.add(childName);
        if (marker) {
          this.setMarkerDisplay(marker, false);
        }
      }, duration);
    }
  }

  /**
   * Toggle expand/collapse state.
   */
  toggleRegion(regionName: string, animation: ExpandAnimation = 'outward', duration = 400): void {
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
  private collapseAllRegions(duration = 150): void {
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

  dispose(): void {
    this.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.labelsContainer.remove();
    this.scene.remove(this.occlusionGroup);
  }

  private refreshLaterality(): void {
    this.laterality = detectAnnotationLaterality(this.model, this.regions, boneResolutionProfile(this.characterConfig));
  }
}
