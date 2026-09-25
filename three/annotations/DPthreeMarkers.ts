import { boneResolutionProfile } from './boneResolutionProfile';
import * as THREE from 'three';
import { fuzzyNameMatch, passesMarkerCameraAngleGate, resolveBoneNames } from './adapter';
import type { Region, CharacterConfig } from './types';

/**
 * 3D visual markers for regions that can be clicked
 */
export class DPthreeMarkers {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private domElement: HTMLElement;
  private markers: Map<string, THREE.Sprite> = new Map();
  private labels: Map<string, HTMLDivElement> = new Map();
  private labelsContainer: HTMLDivElement;
  private raycaster: THREE.Raycaster;
  private onSelect: (name: string) => void;
  private model: THREE.Object3D | null = null;
  private regions: Region[] = [];
  private characterConfig: CharacterConfig | null = null;
  private currentRegion: string | null = null;

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
    this.raycaster = new THREE.Raycaster();

    // Create container for HTML labels
    this.labelsContainer = document.createElement('div');
    this.labelsContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      overflow: hidden;
    `;

    // Find parent with relative positioning or the canvas parent
    const parent = this.domElement.parentElement;
    if (parent) {
      const style = window.getComputedStyle(parent);
      if (style.position === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(this.labelsContainer);
    }

    // Add click handler
    this.domElement.addEventListener('click', this.onClick);
  }

  setModel(model: THREE.Object3D): void {
    this.model = model;
  }

  loadRegions(config: CharacterConfig): void {
    this.clear();
    this.characterConfig = config;
    this.regions = config.regions ?? [];

    for (const region of (config.regions ?? [])) {
      this.createMarker(region);
    }
  }

  setCurrentRegion(name: string | null): void {
    this.currentRegion = name;
    this.updateMarkerStyles();
  }

  private createMarker(region: Region): void {
    if (!this.model) return;

    // Calculate center position for this annotation
    const position = this.getRegionCenter(region);
    if (!position) return;

    // Create HTML label (more reliable than sprites for clicking)
    const label = document.createElement('div');
    label.className = 'annotation-marker';
    label.dataset.annotation = region.name;
    label.innerHTML = `
      <div class="marker-dot"></div>
      <div class="marker-label">${this.formatName(region.name)}</div>
    `;
    label.style.cssText = `
      position: absolute;
      transform: translate(-50%, -50%);
      pointer-events: auto;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: rgba(0, 0, 0, 0.6);
      border-radius: 16px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      transition: all 0.2s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 11px;
      color: white;
      white-space: nowrap;
      z-index: 100;
    `;

    // Style the dot
    const dot = label.querySelector('.marker-dot') as HTMLElement;
    if (dot) {
      dot.style.cssText = `
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #4299e1;
        box-shadow: 0 0 6px #4299e1;
      `;
    }

    // Add hover effect
    label.addEventListener('mouseenter', () => {
      label.style.background = 'rgba(66, 153, 225, 0.8)';
      label.style.borderColor = '#4299e1';
    });
    label.addEventListener('mouseleave', () => {
      if (this.currentRegion !== region.name) {
        label.style.background = 'rgba(0, 0, 0, 0.6)';
        label.style.borderColor = 'rgba(255, 255, 255, 0.2)';
      }
    });

    // Add click handler
    label.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onSelect(region.name);
    });

    this.labelsContainer.appendChild(label);
    this.labels.set(region.name, label);

    // Store position for updates
    (label as any).__position = position.clone();
  }

  private getRegionCenter(region: Region): THREE.Vector3 | null {
    if (!this.model) return null;

    const box = new THREE.Box3();
    let hasObjects = false;

    // Handle '*' for full model
    if (region.objects?.includes('*')) {
      box.expandByObject(this.model);
      hasObjects = true;
    } else {
      // Find bones
      if (region.bones) {
        const resolvedBoneNames = resolveBoneNames(region.bones, boneResolutionProfile(this.characterConfig) ?? undefined);
        for (const boneName of resolvedBoneNames) {
          this.model.traverse((obj) => {
            if (fuzzyNameMatch(obj.name, boneName, this.characterConfig?.suffixPattern)) {
              const worldPos = new THREE.Vector3();
              obj.getWorldPosition(worldPos);
              box.expandByPoint(worldPos);
              hasObjects = true;
            }
          });
        }
      }

      // Find meshes - Note: For skinned meshes, prefer also specifying bones
      // for accurate marker positioning since mesh world position may be at origin
      if (region.meshes) {
        for (const meshName of region.meshes) {
          this.model.traverse((obj) => {
            if (obj.name === meshName && (obj as THREE.Mesh).isMesh) {
              box.expandByObject(obj);
              hasObjects = true;
            }
          });
        }
      }
    }

    if (!hasObjects || box.isEmpty()) return null;

    const center = new THREE.Vector3();
    box.getCenter(center);

    // If annotation has a cameraAngle, offset the marker position to that side of the model
    // This makes markers appear on the appropriate surface (e.g., back marker on the back)
    if (region.cameraAngle !== undefined && region.cameraAngle !== 0) {
      // Get the model's bounding box to determine offset distance
      const modelBox = new THREE.Box3().setFromObject(this.model);
      const modelSize = new THREE.Vector3();
      modelBox.getSize(modelSize);

      // Use half the depth (z-axis) as the offset distance
      const offsetDistance = modelSize.z * 0.5;

      // Calculate offset direction based on camera angle
      const angleRad = (region.cameraAngle * Math.PI) / 180;
      center.x += Math.sin(angleRad) * offsetDistance;
      center.z -= Math.cos(angleRad) * offsetDistance;
    }

    return center;
  }

  private formatName(name: string): string {
    return name
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  private updateMarkerStyles(): void {
    for (const [name, label] of this.labels) {
      if (name === this.currentRegion) {
        label.style.background = 'rgba(66, 153, 225, 0.8)';
        label.style.borderColor = '#4299e1';
      } else {
        label.style.background = 'rgba(0, 0, 0, 0.6)';
        label.style.borderColor = 'rgba(255, 255, 255, 0.2)';
      }
    }
  }

  private onClick = (event: MouseEvent): void => {
    // This handles clicks on the 3D canvas that might hit markers
    // The HTML labels handle their own clicks
  };

  /**
   * Update label positions - call this in render loop
   *
   * Occlusion: Uses efficient dot product check - if marker is on opposite side
   * of model from camera (dot product < 0), hide it. O(1) per marker.
   */
  update(): void {
    if (!this.model) return;

    const rect = this.domElement.getBoundingClientRect();

    // Calculate camera's viewing angle around the model (in degrees)
    // This tells us if we're looking from front (0°), back (180°), etc.
    const modelCenter = new THREE.Vector3();
    new THREE.Box3().setFromObject(this.model).getCenter(modelCenter);

    // Camera direction from model center (for dot product occlusion)
    const dx = this.camera.position.x - modelCenter.x;
    const dy = this.camera.position.y - modelCenter.y;
    const dz = this.camera.position.z - modelCenter.z;
    const cameraDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const cameraDirX = dx / cameraDistance;
    const cameraDirY = dy / cameraDistance;
    const cameraDirZ = dz / cameraDistance;

    const cameraAngle = Math.atan2(dx, dz) * (180 / Math.PI);

    // First pass: calculate positions and visibility
    const visibleLabels: Array<{ name: string; label: HTMLDivElement; x: number; y: number }> = [];

    for (const [name, label] of this.labels) {
      const position = (label as any).__position as THREE.Vector3;
      if (!position) continue;

      // Update position based on current model transform
      const region = this.regions.find(a => a.name === name);
      if (region) {
        const newPos = this.getRegionCenter(region);
        if (newPos) {
          position.copy(newPos);
        }
      }

      // Project to screen space
      const screenPos = position.clone().project(this.camera);

      // Check if in front of camera
      if (screenPos.z > 1) {
        label.style.display = 'none';
        continue;
      }

      let visible = true;

      // For markers with a cameraAngle, only show when camera is viewing from approximately that angle
      // This ensures "back" marker only shows when viewing from behind
      if (region?.cameraAngle !== undefined && region.cameraAngle !== 0) {
        visible = passesMarkerCameraAngleGate({
          markerAngle: region.cameraAngle,
          currentCameraAngle: cameraAngle,
        });
      } else {
        // Dot product occlusion for front-facing markers
        const markerDirX = position.x - modelCenter.x;
        const markerDirY = position.y - modelCenter.y;
        const markerDirZ = position.z - modelCenter.z;

        // Dot product: positive = same side as camera, negative = opposite side
        const dot = markerDirX * cameraDirX + markerDirY * cameraDirY + markerDirZ * cameraDirZ;
        visible = dot > -0.01;
      }

      if (!visible) {
        label.style.display = 'none';
        continue;
      }

      label.style.display = 'flex';

      // Convert to CSS coordinates
      const x = (screenPos.x * 0.5 + 0.5) * rect.width;
      const y = (-screenPos.y * 0.5 + 0.5) * rect.height;

      visibleLabels.push({ name, label, x, y });
    }

    // Second pass: spread overlapping labels vertically and horizontally
    const labelHeight = 24; // Approximate label height
    const labelWidth = 80;  // Approximate label width
    const minVerticalGap = 8;
    const minHorizontalGap = 10;

    // Sort by Y position (top to bottom) then by X (left to right)
    visibleLabels.sort((a, b) => a.y - b.y || a.x - b.x);

    // Check for overlaps and spread labels apart
    for (let i = 0; i < visibleLabels.length; i++) {
      for (let j = i + 1; j < visibleLabels.length; j++) {
        const a = visibleLabels[i];
        const b = visibleLabels[j];

        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);

        // Check if labels overlap (within bounding box)
        if (dx < labelWidth && dy < labelHeight + minVerticalGap) {
          // Labels overlap - spread them apart
          const overlapY = (labelHeight + minVerticalGap) - dy;
          const overlapX = (labelWidth + minHorizontalGap) - dx;

          // Prefer vertical spreading, but also spread horizontally if needed
          if (overlapY > 0) {
            // Spread vertically: move upper label up, lower label down
            const spreadY = overlapY / 2 + minVerticalGap;
            if (a.y < b.y) {
              a.y -= spreadY;
              b.y += spreadY;
            } else {
              a.y += spreadY;
              b.y -= spreadY;
            }
          }

          // If still horizontally close, also spread horizontally
          if (dx < labelWidth * 0.5 && overlapX > 0) {
            const spreadX = overlapX / 2 + minHorizontalGap;
            if (a.x < b.x) {
              a.x -= spreadX * 0.3;
              b.x += spreadX * 0.3;
            } else {
              a.x += spreadX * 0.3;
              b.x -= spreadX * 0.3;
            }
          }
        }
      }
    }

    // Apply final positions
    for (const { label, x, y } of visibleLabels) {
      label.style.left = `${x}px`;
      label.style.top = `${y}px`;
    }
  }

  /**
   * Show/hide all markers
   */
  setVisible(visible: boolean): void {
    this.labelsContainer.style.display = visible ? 'block' : 'none';
  }

  /**
   * Clear all markers
   */
  clear(): void {
    for (const label of this.labels.values()) {
      label.remove();
    }
    this.labels.clear();
    this.markers.clear();
  }

  /**
   * Dispose and cleanup
   */
  dispose(): void {
    this.domElement.removeEventListener('click', this.onClick);
    this.clear();
    this.labelsContainer.remove();
  }
}
