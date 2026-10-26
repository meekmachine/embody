/**
 * SkeletonOverlay - 3D bone visualization overlay for the Three.js scene.
 *
 * Renders each bone as an elongated octahedral shape (Blender-style armature)
 * stretched from parent joint to child joint. Updates in real-time via
 * onBeforeRender callback, following bone animation.
 */
import { fuzzyNameMatch } from '../authoring';
import * as THREE from 'three';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BoneTreeNode {
  name: string;
  depth: number;
  parent: string | null;
  children: string[];
  isMapped: boolean;
  /** Semantic key if this bone is mapped (e.g., 'HEAD', 'JAW') */
  semanticKey: string | null;
  /** Full semantic-key set for tree badge rendering when a row resolves multiple mappings */
  semanticKeys?: string[];
  /** Live reference to the Three.js bone object */
  boneObject: THREE.Bone;
}

interface BoneVisualization {
  mesh: THREE.Mesh;
  parentBone: THREE.Bone;
  childBone: THREE.Bone | null;
  boneName: string;
  isMapped: boolean;
}

export interface SkeletonOverlayOptions {
  opacityScale?: number;
  focusSelectedBone?: boolean;
}

type OverlayAxisKey = 'pitch' | 'yaw' | 'roll';
export type SkeletonOverlayAxisKey = OverlayAxisKey;
type SkeletonOverlayRotationChannel = 'rx' | 'ry' | 'rz';

export interface AxisGizmoPointerData {
  axis: SkeletonOverlayAxisKey;
  channel: SkeletonOverlayRotationChannel;
  boneName: string;
  point: THREE.Vector3;
  origin: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

// ── Constants ──────────────────────────────────────────────────────────────

const COLORS = {
  mapped: 0x4a9aaa,
  unmapped: 0x5a6a7a,
  highlighted: 0xd4a040,
  selected: 0x63b3ed,
} as const;

const OPACITY = {
  mapped: 0.58,
  unmapped: 0.38,
  highlighted: 0.7,
  selected: 0.8,
  context: 0.46,
  muted: 0.16,
} as const;

const AXIS_GIZMO_COLORS: Record<OverlayAxisKey, number> = {
  pitch: 0xff7a5c,
  yaw: 0x61d095,
  roll: 0x69a8ff,
};

const AXIS_GIZMO_IDLE_OPACITY = 0.72;
const AXIS_GIZMO_MUTED_OPACITY = 0.26;
const AXIS_GIZMO_ACTIVE_OPACITY = 0.96;
const AXIS_GIZMO_RADIUS_FACTOR = 0.48;
const AXIS_GIZMO_MIN_RADIUS = 0.025;
const AXIS_GIZMO_MAX_RADIUS = 0.14;
const AXIS_GIZMO_SCREEN_RADIUS_PX = 54;
const AXIS_GIZMO_ACTIVE_SCALE = 1.05;
const AXIS_GIZMO_HIT_TUBE = 0.15;
const VISIBILITY_FADE_MS = 180;
const VISIBILITY_EPSILON = 0.01;

/** Default length for leaf bones (no children) */
const LEAF_BONE_LENGTH = 0.02;

/** Width ratio of octahedron mid-section relative to bone length */
const WIDTH_RATIO = 0.1;

/** Position of mid-section along bone axis (0 = parent, 1 = child) */
const MID_POSITION = 0.2;

/** Helper/root bones that can introduce non-deforming rig offsets */
const ROOT_HELPER_NAME_PATTERN = /armature|bone.?root|rootjoint|(?:^|[_\W])root(?:$|[_\W])/i;
const HIP_NAME_PATTERN = /(?:^|[_\W])hip(?:$|[_\W]|\d)/i;
const PELVIS_NAME_PATTERN = /(?:^|[_\W])pelvis(?:$|[_\W]|\d)/i;
/** Distance threshold for treating two joints as occupying the same point */
const POSITION_EPSILON = 1e-4;
const DEFAULT_AXIS_CHANNELS: Record<OverlayAxisKey, SkeletonOverlayRotationChannel> = {
  pitch: 'rx',
  yaw: 'ry',
  roll: 'rz',
};

// ── Geometry ───────────────────────────────────────────────────────────────

/**
 * Creates a unit octahedral bone geometry (Blender-style).
 * Two pyramids joined at a wider mid-section, extending along +Z axis from 0 to 1.
 *
 * Vertices:
 *   root (0,0,0) → mid cross-section at z=0.2 → tip (0,0,1)
 */
function createOctahedralBoneGeometry(): THREE.BufferGeometry {
  const w = WIDTH_RATIO;

  // 6 vertices: root, 4 mid-section corners, tip
  const positions = new Float32Array([
    // Face 0: root → mid1 → mid2
    0, 0, 0,   w, w, MID_POSITION,   -w, w, MID_POSITION,
    // Face 1: root → mid2 → mid3
    0, 0, 0,   -w, w, MID_POSITION,   -w, -w, MID_POSITION,
    // Face 2: root → mid3 → mid4
    0, 0, 0,   -w, -w, MID_POSITION,   w, -w, MID_POSITION,
    // Face 3: root → mid4 → mid1
    0, 0, 0,   w, -w, MID_POSITION,   w, w, MID_POSITION,
    // Face 4: tip → mid2 → mid1
    0, 0, 1,   -w, w, MID_POSITION,   w, w, MID_POSITION,
    // Face 5: tip → mid3 → mid2
    0, 0, 1,   -w, -w, MID_POSITION,   -w, w, MID_POSITION,
    // Face 6: tip → mid4 → mid3
    0, 0, 1,   w, -w, MID_POSITION,   -w, -w, MID_POSITION,
    // Face 7: tip → mid1 → mid4
    0, 0, 1,   w, w, MID_POSITION,   w, -w, MID_POSITION,
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function collectBones(root: THREE.Object3D): THREE.Bone[] {
  const bones = new Set<THREE.Bone>();
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      bones.add(obj as THREE.Bone);
    }
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
      const skinned = obj as THREE.SkinnedMesh;
      skinned.skeleton?.bones?.forEach((bone) => bones.add(bone));
    }
  });
  return Array.from(bones);
}

function isBone(obj: THREE.Object3D | null | undefined): obj is THREE.Bone {
  return !!obj && (obj as THREE.Bone).isBone;
}

function countBoneSubtree(bone: THREE.Bone): number {
  let count = 1;
  for (const child of bone.children) {
    if (isBone(child)) {
      count += countBoneSubtree(child);
    }
  }
  return count;
}

function resolveTopLevelHelperRoot(root: THREE.Object3D): THREE.Bone | null {
  const topLevelBones = collectBones(root).filter((bone) => !isBone(bone.parent));
  if (topLevelBones.length !== 1) return null;

  let helperRoot = topLevelBones[0];
  while (ROOT_HELPER_NAME_PATTERN.test(helperRoot.name)) {
    const boneChildren = helperRoot.children.filter(isBone);
    if (boneChildren.length !== 1) break;

    const onlyChild = boneChildren[0];
    if (!ROOT_HELPER_NAME_PATTERN.test(onlyChild.name)) break;
    helperRoot = onlyChild;
  }

  return ROOT_HELPER_NAME_PATTERN.test(helperRoot.name) ? helperRoot : null;
}

function resolveBodyDisplayRoot(root: THREE.Object3D): THREE.Bone | null {
  const helperRoot = resolveTopLevelHelperRoot(root);
  if (!helperRoot) return null;

  const boneChildren = helperRoot.children.filter(isBone);
  if (boneChildren.length === 0) return null;
  if (boneChildren.length === 1) return boneChildren[0];

  // Export rigs sometimes hang tiny attachment helpers off the root alongside
  // one real body subtree. Start the overlay at that dominant body child.
  const subtreeSizes = boneChildren
    .map((child) => ({ child, size: countBoneSubtree(child) }))
    .sort((left, right) => right.size - left.size);

  const [largest, secondLargest] = subtreeSizes;
  if (!largest || largest.size < 3) return null;
  if (!secondLargest || secondLargest.size <= 2 || largest.size >= secondLargest.size * 3) {
    return largest.child;
  }

  return null;
}

function collectBoneChildren(bone: THREE.Object3D): THREE.Bone[] {
  return bone.children.filter(isBone);
}

function hasZeroLengthConnection(parentBone: THREE.Bone, childBone: THREE.Bone): boolean {
  parentBone.getWorldPosition(_parentPos);
  childBone.getWorldPosition(_childPos);
  return _parentPos.distanceToSquared(_childPos) <= POSITION_EPSILON * POSITION_EPSILON;
}

function hasRootHelperAncestor(bone: THREE.Bone): boolean {
  let current: THREE.Object3D | null = bone.parent;
  while (isBone(current)) {
    if (ROOT_HELPER_NAME_PATTERN.test(current.name)) return true;
    current = current.parent;
  }
  return false;
}

function shouldSkipRootHelperConnection(parentBone: THREE.Bone, boneChildren: THREE.Bone[]): boolean {
  if (boneChildren.length !== 1) return false;
  const childBone = boneChildren[0];

  if (ROOT_HELPER_NAME_PATTERN.test(parentBone.name)) {
    if (!isBone(parentBone.parent)) return true;

    // Nested human rig helpers still produce a useless centerline when the
    // helper feeds into a hip whose pelvis child collapses to the same point.
    return collectBoneChildren(childBone).some((grandChild) => hasZeroLengthConnection(childBone, grandChild));
  }

  return (
    hasRootHelperAncestor(parentBone) &&
    HIP_NAME_PATTERN.test(parentBone.name) &&
    PELVIS_NAME_PATTERN.test(childBone.name) &&
    hasZeroLengthConnection(parentBone, childBone)
  );
}

function setRayFromPointer(
  clientX: number,
  clientY: number,
  camera: THREE.Camera,
  domElement: HTMLElement,
): boolean {
  const rect = domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;

  _mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _raycaster.setFromCamera(_mouse, camera);
  return true;
}

// ── Reusable temp objects (avoid GC) ───────────────────────────────────────

const _parentPos = new THREE.Vector3();
const _childPos = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _quaternion = new THREE.Quaternion();
const _bonePos = new THREE.Vector3();
const _boneQuat = new THREE.Quaternion();
const _boneEuler = new THREE.Euler();
const _mouse = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _cameraSpacePosition = new THREE.Vector3();
const _planeNormal = new THREE.Vector3();
const _dragPlane = new THREE.Plane();
const _planeHit = new THREE.Vector3();

export function resolveSkeletonOverlayStartBoneName(
  root: THREE.Object3D,
): string | null {
  return resolveBodyDisplayRoot(root)?.name ?? null;
}

// ── SkeletonOverlay Class ──────────────────────────────────────────────────

export class SkeletonOverlay {
  private scene: THREE.Scene;
  private group: THREE.Group;
  private visualizations: BoneVisualization[] = [];
  private boneTree: BoneTreeNode[] = [];
  private mappedBoneNames: Set<string>;
  private semanticKeyMap: Map<string, string>; // boneName → semanticKey
  private boneLookup = new Map<string, THREE.Bone>();

  // Shared geometry and materials
  private sharedGeometry: THREE.BufferGeometry;
  private mappedMaterial: THREE.MeshBasicMaterial;
  private unmappedMaterial: THREE.MeshBasicMaterial;
  private highlightMaterial: THREE.MeshBasicMaterial;
  private selectedMaterial: THREE.MeshBasicMaterial;
  private contextMaterial: THREE.MeshBasicMaterial;
  private mutedMaterial: THREE.MeshBasicMaterial;
  private axisRingGeometry: THREE.TorusGeometry;
  private axisRingHitGeometry: THREE.TorusGeometry;
  private axisCenterGeometry: THREE.SphereGeometry;
  private pitchRingMaterial: THREE.MeshBasicMaterial;
  private yawRingMaterial: THREE.MeshBasicMaterial;
  private rollRingMaterial: THREE.MeshBasicMaterial;
  private axisHitMaterial: THREE.MeshBasicMaterial;
  private axisCenterMaterial: THREE.MeshBasicMaterial;
  private axisGizmoGroup: THREE.Group;
  private axisGizmoMeshes: Record<OverlayAxisKey, THREE.Mesh>;
  private axisGizmoHitMeshes: Record<OverlayAxisKey, THREE.Mesh>;

  // Sentinel mesh for per-frame updates (stored for disposal)
  private sentinelMesh: THREE.Mesh | null = null;

  // State
  private highlightedBone: string | null = null;
  private selectedBone: string | null = null;
  private activeAxis: OverlayAxisKey | null = null;
  private opacityScale: number;
  private focusSelectedBone: boolean;
  private visibilityAlpha = 0;
  private visibilityTarget = 0;
  private visibilityLastFrameAt = 0;

  constructor(
    scene: THREE.Scene,
    mappedBoneNames: Set<string>,
    semanticKeyMap: Map<string, string>,
    options: SkeletonOverlayOptions = {},
  ) {
    this.scene = scene;
    this.mappedBoneNames = mappedBoneNames;
    this.semanticKeyMap = semanticKeyMap;
    this.opacityScale = THREE.MathUtils.clamp(options.opacityScale ?? 1, 0, 1);
    this.focusSelectedBone = options.focusSelectedBone ?? false;

    this.group = new THREE.Group();
    this.group.name = 'SkeletonOverlay';
    this.group.renderOrder = 999;
    this.group.visible = false;

    this.sharedGeometry = createOctahedralBoneGeometry();

    const materialOpts: Partial<THREE.MeshBasicMaterialParameters> = {
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    };

    this.mappedMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: COLORS.mapped, opacity: OPACITY.mapped });
    this.unmappedMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: COLORS.unmapped, opacity: OPACITY.unmapped });
    this.highlightMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: COLORS.highlighted, opacity: OPACITY.highlighted });
    this.selectedMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: COLORS.selected, opacity: OPACITY.selected });
    this.contextMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: COLORS.selected, opacity: OPACITY.context });
    this.mutedMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: COLORS.unmapped, opacity: OPACITY.muted });
    this.mappedMaterial.forceSinglePass = true;
    this.unmappedMaterial.forceSinglePass = true;
    this.highlightMaterial.forceSinglePass = true;
    this.selectedMaterial.forceSinglePass = true;
    this.contextMaterial.forceSinglePass = true;
    this.mutedMaterial.forceSinglePass = true;

    this.axisRingGeometry = new THREE.TorusGeometry(1, 0.032, 10, 120);
    this.axisRingHitGeometry = new THREE.TorusGeometry(1, AXIS_GIZMO_HIT_TUBE, 8, 64);
    this.axisCenterGeometry = new THREE.SphereGeometry(0.082, 12, 8);
    this.pitchRingMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: AXIS_GIZMO_COLORS.pitch, opacity: AXIS_GIZMO_IDLE_OPACITY });
    this.yawRingMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: AXIS_GIZMO_COLORS.yaw, opacity: AXIS_GIZMO_IDLE_OPACITY });
    this.rollRingMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: AXIS_GIZMO_COLORS.roll, opacity: AXIS_GIZMO_IDLE_OPACITY });
    this.axisHitMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, opacity: 0 });
    this.axisHitMaterial.colorWrite = false;
    this.axisCenterMaterial = new THREE.MeshBasicMaterial({ ...materialOpts, color: 0xf5f7fa, opacity: 0.92 });

    this.axisGizmoGroup = new THREE.Group();
    this.axisGizmoGroup.name = 'SelectedBoneAxisGizmo';
    this.axisGizmoGroup.visible = false;
    this.axisGizmoGroup.renderOrder = 1000;

    const pitchRing = new THREE.Mesh(this.axisRingGeometry, this.pitchRingMaterial);
    pitchRing.renderOrder = 1000;
    pitchRing.userData.axis = 'pitch';
    const pitchHit = new THREE.Mesh(this.axisRingHitGeometry, this.axisHitMaterial);
    pitchHit.userData.axis = 'pitch';

    const yawRing = new THREE.Mesh(this.axisRingGeometry, this.yawRingMaterial);
    yawRing.renderOrder = 1000;
    yawRing.userData.axis = 'yaw';
    const yawHit = new THREE.Mesh(this.axisRingHitGeometry, this.axisHitMaterial);
    yawHit.userData.axis = 'yaw';

    const rollRing = new THREE.Mesh(this.axisRingGeometry, this.rollRingMaterial);
    rollRing.renderOrder = 1000;
    rollRing.userData.axis = 'roll';
    const rollHit = new THREE.Mesh(this.axisRingHitGeometry, this.axisHitMaterial);
    rollHit.rotation.copy(rollRing.rotation);
    rollHit.userData.axis = 'roll';

    const center = new THREE.Mesh(this.axisCenterGeometry, this.axisCenterMaterial);
    center.renderOrder = 1001;

    this.axisGizmoMeshes = {
      pitch: pitchRing,
      yaw: yawRing,
      roll: rollRing,
    };
    this.axisGizmoHitMeshes = {
      pitch: pitchHit,
      yaw: yawHit,
      roll: rollHit,
    };

    Object.values(this.axisGizmoMeshes).forEach((mesh) => {
      mesh.frustumCulled = false;
      this.axisGizmoGroup.add(mesh);
    });
    Object.values(this.axisGizmoHitMeshes).forEach((mesh) => {
      mesh.frustumCulled = false;
      this.axisGizmoGroup.add(mesh);
    });
    center.frustumCulled = false;
    this.axisGizmoGroup.add(center);
    this.syncAxisGizmoChannels();
    this.syncVisibilityOpacity();
    this.updateAxisGizmoAppearance();
  }

  /**
   * Build the skeleton visualization from a scene root.
   * Traverses to find all THREE.Bone instances and creates octahedral meshes.
   */
  loadSkeleton(root: THREE.Object3D): void {
    this.clear();
    root.updateWorldMatrix(true, true);

    // Collect all bones
    const allBones = collectSkeletonBones(root);
    const includedBones = new Set(allBones);
    this.boneLookup = new Map(allBones.map((bone) => [bone.name, bone]));

    if (allBones.length === 0) return;

    // Build tree data for UI
    this.boneTree = allBones.map((bone) => {
      const isMapped = this.mappedBoneNames.has(bone.name);
      const semanticKey = this.semanticKeyMap.get(bone.name) ?? null;
      const boneChildren = bone.children
        .filter((c): c is THREE.Bone => isBone(c) && includedBones.has(c))
        .map((c) => c.name);
      const parentName = bone.parent && isBone(bone.parent) && includedBones.has(bone.parent)
        ? bone.parent.name
        : null;

      // Compute depth by walking up
      let depth = 0;
      let current: THREE.Object3D | null = bone.parent;
      while (current && isBone(current) && includedBones.has(current)) {
        depth++;
        current = current.parent;
      }

      return {
        name: bone.name,
        depth,
        parent: parentName,
        children: boneChildren,
        isMapped,
        semanticKey,
        boneObject: bone,
      };
    });

    // Create visualization meshes for each bone→child connection
    for (const bone of allBones) {
      const boneChildren = bone.children.filter(
        (c): c is THREE.Bone => isBone(c) && includedBones.has(c),
      );

      if (boneChildren.length > 0) {
        // Root/helper bones often exist only for rig transforms and produce
        // a misleading centerline (for example between a character's legs).
        if (shouldSkipRootHelperConnection(bone, boneChildren)) {
          continue;
        }

        for (const child of boneChildren) {
          this.createBoneMesh(bone, child);
        }
      } else {
        this.createBoneMesh(bone, null);
      }
    }

    this.group.add(this.axisGizmoGroup);

    // Attach onBeforeRender to a sentinel mesh for per-frame updates
    const sentinelGeo = new THREE.SphereGeometry(1e-6, 4, 2);
    const sentinelMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
    });
    sentinelMat.colorWrite = false;
    const sentinel = new THREE.Mesh(sentinelGeo, sentinelMat);
    sentinel.visible = true;
    sentinel.frustumCulled = false;
    sentinel.onBeforeRender = (renderer, _scene, camera) => this.update(camera, renderer.domElement);
    this.sentinelMesh = sentinel;
    this.group.add(sentinel);

    this.scene.add(this.group);
    this.update();
  }

  private createBoneMesh(parentBone: THREE.Bone, childBone: THREE.Bone | null): void {
    const isMapped = this.mappedBoneNames.has(parentBone.name);
    const material = isMapped ? this.mappedMaterial : this.unmappedMaterial;

    const mesh = new THREE.Mesh(this.sharedGeometry, material);
    mesh.name = `bone_vis_${parentBone.name}${childBone ? `_${childBone.name}` : '_leaf'}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 999;

    // Store bone name for picking
    mesh.userData.boneName = parentBone.name;

    this.visualizations.push({
      mesh,
      parentBone,
      childBone,
      boneName: parentBone.name,
      isMapped,
    });

    this.group.add(mesh);
  }

  /** Called each frame via onBeforeRender. Updates all bone mesh transforms. */
  private update(camera?: THREE.Camera | null, domElement?: HTMLElement | null): void {
    this.advanceVisibility();

    for (const vis of this.visualizations) {
      vis.parentBone.getWorldPosition(_parentPos);

      if (vis.childBone) {
        vis.childBone.getWorldPosition(_childPos);
      } else {
        // Leaf bone: extend a short distance along bone's local Y axis
        _childPos.set(0, LEAF_BONE_LENGTH, 0);
        vis.parentBone.localToWorld(_childPos);
      }

      // Compute direction and length
      _direction.subVectors(_childPos, _parentPos);
      const length = _direction.length();

      if (length < 0.0001) {
        vis.mesh.visible = false;
        continue;
      }

      vis.mesh.visible = this.visibilityAlpha > VISIBILITY_EPSILON;

      // Orient: geometry is authored along +Z, align it with parent→child direction
      _direction.normalize();
      _quaternion.setFromUnitVectors(_zAxis, _direction);

      vis.mesh.position.copy(_parentPos);
      vis.mesh.quaternion.copy(_quaternion);
      vis.mesh.scale.set(length, length, length);
    }

    this.updateAxisGizmo(camera, domElement);
  }

  private syncVisibilityOpacity(): void {
    const alpha = this.visibilityAlpha * this.opacityScale;
    this.mappedMaterial.opacity = OPACITY.mapped * alpha;
    this.unmappedMaterial.opacity = OPACITY.unmapped * alpha;
    this.highlightMaterial.opacity = OPACITY.highlighted * alpha;
    this.selectedMaterial.opacity = OPACITY.selected * alpha;
    this.contextMaterial.opacity = OPACITY.context * alpha;
    this.mutedMaterial.opacity = OPACITY.muted * alpha;
  }

  private syncGroupVisibility(): void {
    this.group.visible = this.visualizations.length > 0 && (
      this.visibilityTarget > 0 ||
      this.visibilityAlpha > VISIBILITY_EPSILON ||
      this.selectedBone != null
    );
  }

  private advanceVisibility(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const deltaMs = this.visibilityLastFrameAt > 0 ? now - this.visibilityLastFrameAt : 16;
    this.visibilityLastFrameAt = now;

    if (Math.abs(this.visibilityAlpha - this.visibilityTarget) > VISIBILITY_EPSILON) {
      const step = deltaMs / VISIBILITY_FADE_MS;
      if (this.visibilityTarget > this.visibilityAlpha) {
        this.visibilityAlpha = Math.min(this.visibilityTarget, this.visibilityAlpha + step);
      } else {
        this.visibilityAlpha = Math.max(this.visibilityTarget, this.visibilityAlpha - step);
      }
    } else {
      this.visibilityAlpha = this.visibilityTarget;
    }

    if (this.visibilityAlpha <= VISIBILITY_EPSILON && this.visibilityTarget === 0) {
      this.visibilityAlpha = 0;
    }

    this.syncVisibilityOpacity();
    this.syncGroupVisibility();
  }

  private resolveSelectedBoneObject(): THREE.Bone | null {
    if (!this.selectedBone) return null;
    return this.boneLookup.get(this.selectedBone) ?? null;
  }

  private resolveBoneRelativeAxisGizmoRadius(bone: THREE.Bone): number {
    bone.getWorldPosition(_parentPos);

    let referenceLength = 0;
    for (const child of bone.children) {
      if (!isBone(child)) continue;
      child.getWorldPosition(_childPos);
      const nextDistance = _parentPos.distanceTo(_childPos);
      if (nextDistance <= 0.0001) continue;
      referenceLength = referenceLength === 0 ? nextDistance : Math.min(referenceLength, nextDistance);
    }

    if (referenceLength <= 0.0001 && isBone(bone.parent)) {
      bone.parent.getWorldPosition(_childPos);
      referenceLength = _parentPos.distanceTo(_childPos);
    }

    if (referenceLength <= 0.0001) {
      referenceLength = LEAF_BONE_LENGTH;
    }

    return THREE.MathUtils.clamp(
      referenceLength * AXIS_GIZMO_RADIUS_FACTOR,
      AXIS_GIZMO_MIN_RADIUS,
      AXIS_GIZMO_MAX_RADIUS,
    );
  }

  private resolveScreenSpaceAxisGizmoRadius(
    origin: THREE.Vector3,
    camera?: THREE.Camera | null,
    domElement?: HTMLElement | null,
  ): number | null {
    if (!camera || !domElement) return null;

    const rect = domElement.getBoundingClientRect();
    const viewportHeight = domElement.clientHeight || rect.height;
    if (viewportHeight <= 0) return null;

    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const perspectiveCamera = camera as THREE.PerspectiveCamera;
      _cameraSpacePosition.copy(origin).applyMatrix4(perspectiveCamera.matrixWorldInverse);
      const depth = -_cameraSpacePosition.z;
      if (!Number.isFinite(depth) || depth <= perspectiveCamera.near) return null;

      const visibleWorldHeight = 2
        * depth
        * Math.tan(THREE.MathUtils.degToRad(perspectiveCamera.getEffectiveFOV()) / 2);
      return visibleWorldHeight * (AXIS_GIZMO_SCREEN_RADIUS_PX / viewportHeight);
    }

    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const orthographicCamera = camera as THREE.OrthographicCamera;
      const visibleWorldHeight = (orthographicCamera.top - orthographicCamera.bottom) / orthographicCamera.zoom;
      return visibleWorldHeight * (AXIS_GIZMO_SCREEN_RADIUS_PX / viewportHeight);
    }

    return null;
  }

  private resolveAxisGizmoRadius(
    bone: THREE.Bone,
    origin: THREE.Vector3,
    camera?: THREE.Camera | null,
    domElement?: HTMLElement | null,
  ): number {
    return this.resolveScreenSpaceAxisGizmoRadius(origin, camera, domElement)
      ?? this.resolveBoneRelativeAxisGizmoRadius(bone);
  }

  private updateAxisGizmoAppearance(): void {
    const hasSelection = !!this.selectedBone;
    this.axisGizmoGroup.visible = hasSelection && this.group.visible;

    const meshes: Array<[OverlayAxisKey, THREE.Mesh, THREE.Mesh]> = [
      ['pitch', this.axisGizmoMeshes.pitch, this.axisGizmoHitMeshes.pitch],
      ['yaw', this.axisGizmoMeshes.yaw, this.axisGizmoHitMeshes.yaw],
      ['roll', this.axisGizmoMeshes.roll, this.axisGizmoHitMeshes.roll],
    ];

    meshes.forEach(([axis, mesh, hitMesh]) => {
      const material = mesh.material as THREE.MeshBasicMaterial;
      const isActive = this.activeAxis === axis;
      const baseOpacity = this.activeAxis == null
        ? AXIS_GIZMO_IDLE_OPACITY
        : isActive
          ? AXIS_GIZMO_ACTIVE_OPACITY
          : AXIS_GIZMO_MUTED_OPACITY;
      material.opacity = hasSelection ? baseOpacity : 0;
      const scale = isActive ? AXIS_GIZMO_ACTIVE_SCALE : 1;
      mesh.scale.setScalar(scale);
      hitMesh.scale.setScalar(scale);
    });
    this.axisCenterMaterial.opacity = hasSelection ? 0.92 : 0;
  }

  private updateAxisGizmo(camera?: THREE.Camera | null, domElement?: HTMLElement | null): void {
    const selectedBone = this.resolveSelectedBoneObject();
    if (!selectedBone || !this.group.visible) {
      this.axisGizmoGroup.visible = false;
      return;
    }

    selectedBone.getWorldPosition(_bonePos);
    selectedBone.getWorldQuaternion(_boneQuat);
    const radius = this.resolveAxisGizmoRadius(selectedBone, _bonePos, camera, domElement);

    this.axisGizmoGroup.visible = true;
    this.axisGizmoGroup.position.copy(_bonePos);
    this.axisGizmoGroup.quaternion.copy(_boneQuat);
    this.axisGizmoGroup.scale.setScalar(radius);
    this.updateAxisGizmoAppearance();
    this.axisGizmoGroup.updateWorldMatrix(true, true);
  }

  private applyAxisRingChannel(
    mesh: THREE.Mesh,
    hitMesh: THREE.Mesh,
    axis: SkeletonOverlayAxisKey,
  ): void {
    const channel = DEFAULT_AXIS_CHANNELS[axis];
    mesh.rotation.set(0, 0, 0);
    hitMesh.rotation.set(0, 0, 0);

    if (channel === 'rx') {
      mesh.rotation.y = Math.PI / 2;
      hitMesh.rotation.y = Math.PI / 2;
      return;
    }

    if (channel === 'ry') {
      mesh.rotation.x = Math.PI / 2;
      hitMesh.rotation.x = Math.PI / 2;
    }
  }

  private syncAxisGizmoChannels(): void {
    (Object.keys(this.axisGizmoMeshes) as OverlayAxisKey[]).forEach((axis) => {
      this.applyAxisRingChannel(
        this.axisGizmoMeshes[axis],
        this.axisGizmoHitMeshes[axis],
        axis,
      );
    });
  }

  private getSelectedBonePointerData(): Omit<AxisGizmoPointerData, 'axis' | 'point' | 'channel'> | null {
    const bone = this.resolveSelectedBoneObject();
    if (!bone || !this.selectedBone) return null;

    bone.getWorldPosition(_bonePos);
    bone.getWorldQuaternion(_boneQuat);

    return {
      boneName: this.selectedBone,
      origin: _bonePos.clone(),
      quaternion: _boneQuat.clone(),
    };
  }

  private getAxisPlaneNormal(axis: SkeletonOverlayAxisKey, quaternion: THREE.Quaternion): THREE.Vector3 {
    const channel = DEFAULT_AXIS_CHANNELS[axis];
    if (channel === 'rx') {
      return _planeNormal.set(1, 0, 0).applyQuaternion(quaternion).normalize();
    }
    if (channel === 'ry') {
      return _planeNormal.set(0, 1, 0).applyQuaternion(quaternion).normalize();
    }
    return _planeNormal.set(0, 0, 1).applyQuaternion(quaternion).normalize();
  }

  // ── Public API ─────────────────────────────────────────────────────────

  getBoneTree(): BoneTreeNode[] {
    return this.boneTree;
  }

  setVisible(visible: boolean): void {
    this.visibilityTarget = visible ? 1 : 0;
    this.visibilityLastFrameAt = 0;
    this.syncGroupVisibility();
    this.advanceVisibility();
    this.updateAxisGizmoAppearance();
  }

  isVisible(): boolean {
    return this.visibilityTarget > 0;
  }

  setHighlighted(boneName: string | null): void {
    this.highlightedBone = boneName;
    this.refreshBoneMaterials();
  }

  setSelected(boneName: string | null): void {
    this.selectedBone = boneName;

    this.refreshBoneMaterials();
    this.syncGroupVisibility();
    this.updateAxisGizmo();
  }

  setActiveAxis(axis: OverlayAxisKey | null): void {
    this.activeAxis = axis;
    this.updateAxisGizmoAppearance();
  }

  /** Get world position and rotation for a bone by name */
  getBoneTransform(boneName: string): { position: [number, number, number]; rotation: [number, number, number] } | null {
    const node = this.boneTree.find((b) => b.name === boneName);
    if (!node) return null;

    const bone = node.boneObject;
    bone.getWorldPosition(_bonePos);
    bone.getWorldQuaternion(_boneQuat);
    _boneEuler.setFromQuaternion(_boneQuat);

    return {
      position: [_bonePos.x, _bonePos.y, _bonePos.z],
      rotation: [
        THREE.MathUtils.radToDeg(_boneEuler.x),
        THREE.MathUtils.radToDeg(_boneEuler.y),
        THREE.MathUtils.radToDeg(_boneEuler.z),
      ],
    };
  }

  pickBone(clientX: number, clientY: number, camera: THREE.Camera, domElement: HTMLElement): string | null {
    if (!this.group.visible || this.visibilityTarget <= 0 || this.visibilityAlpha <= 0.35) {
      return null;
    }
    if (!setRayFromPointer(clientX, clientY, camera, domElement)) {
      return null;
    }
    const hits = _raycaster.intersectObjects(
      this.visualizations.map((visualization) => visualization.mesh),
      false,
    );
    const hit = hits[0];
    if (!hit) return null;

    return typeof hit.object.userData.boneName === 'string'
      ? hit.object.userData.boneName
      : null;
  }

  pickAxisGizmo(clientX: number, clientY: number, camera: THREE.Camera, domElement: HTMLElement): AxisGizmoPointerData | null {
    if (!this.axisGizmoGroup.visible || !this.selectedBone) return null;
    this.updateAxisGizmo(camera, domElement);
    if (!this.axisGizmoGroup.visible) return null;
    if (!setRayFromPointer(clientX, clientY, camera, domElement)) {
      return null;
    }

    const hits = _raycaster.intersectObjects(Object.values(this.axisGizmoHitMeshes), false);
    const hit = hits[0];
    if (!hit) return null;

    const axis: unknown = hit.object.userData.axis;
    if (axis !== 'pitch' && axis !== 'yaw' && axis !== 'roll') {
      return null;
    }

    const base = this.getSelectedBonePointerData();
    if (!base) return null;

    return {
      ...base,
      axis,
      channel: DEFAULT_AXIS_CHANNELS[axis],
      point: hit.point.clone(),
    };
  }

  projectPointerToAxisPlane(
    clientX: number,
    clientY: number,
    camera: THREE.Camera,
    domElement: HTMLElement,
    axis: SkeletonOverlayAxisKey,
  ): AxisGizmoPointerData | null {
    if (!this.axisGizmoGroup.visible || !this.selectedBone) {
      return null;
    }
    this.updateAxisGizmo(camera, domElement);
    if (!this.axisGizmoGroup.visible) return null;
    const base = this.getSelectedBonePointerData();
    if (!base) return null;
    if (!setRayFromPointer(clientX, clientY, camera, domElement)) {
      return null;
    }

    const normal = this.getAxisPlaneNormal(axis, base.quaternion);
    _dragPlane.setFromNormalAndCoplanarPoint(normal, base.origin);
    const hit = _raycaster.ray.intersectPlane(_dragPlane, _planeHit);
    if (!hit) return null;

    return {
      ...base,
      axis,
      channel: DEFAULT_AXIS_CHANNELS[axis],
      point: hit.clone(),
    };
  }

  private isSelectedContextBone(boneName: string): boolean {
    if (!this.selectedBone || boneName === this.selectedBone) return false;
    const selectedBone = this.boneLookup.get(this.selectedBone);
    const bone = this.boneLookup.get(boneName);
    if (!selectedBone || !bone) return false;
    return bone.parent === selectedBone || selectedBone.parent === bone;
  }

  private resolveBoneMaterial(boneName: string, isMapped: boolean): THREE.MeshBasicMaterial {
    if (boneName === this.selectedBone) {
      return this.selectedMaterial;
    }
    if (boneName === this.highlightedBone) {
      return this.highlightMaterial;
    }
    if (this.focusSelectedBone && this.selectedBone) {
      return this.isSelectedContextBone(boneName) ? this.contextMaterial : this.mutedMaterial;
    }
    return isMapped ? this.mappedMaterial : this.unmappedMaterial;
  }

  private refreshBoneMaterials(): void {
    for (const vis of this.visualizations) {
      vis.mesh.material = this.resolveBoneMaterial(vis.boneName, vis.isMapped);
    }
  }

  private clear(): void {
    // Dispose sentinel mesh resources before clearing
    if (this.sentinelMesh) {
      this.sentinelMesh.geometry.dispose();
      (this.sentinelMesh.material as THREE.Material).dispose();
      this.sentinelMesh = null;
    }
    // Remove all children from group
    while (this.group.children.length > 0) {
      this.group.remove(this.group.children[0]);
    }
    this.visualizations = [];
    this.boneTree = [];
    this.boneLookup.clear();
    this.axisGizmoGroup.visible = false;
    this.group.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.clear();

    this.sharedGeometry.dispose();
    this.mappedMaterial.dispose();
    this.unmappedMaterial.dispose();
    this.highlightMaterial.dispose();
    this.selectedMaterial.dispose();
    this.contextMaterial.dispose();
    this.mutedMaterial.dispose();
    this.axisRingGeometry.dispose();
    this.axisRingHitGeometry.dispose();
    this.axisCenterGeometry.dispose();
    this.pitchRingMaterial.dispose();
    this.yawRingMaterial.dispose();
    this.rollRingMaterial.dispose();
    this.axisHitMaterial.dispose();
    this.axisCenterMaterial.dispose();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function collectSkeletonBones(root: THREE.Object3D): THREE.Bone[] {
  const startBone = resolveBodyDisplayRoot(root);
  return collectBones(startBone ?? root);
}

/**
 * Find the model root from a scene by locating the first bone
 * and walking up to the top-level scene child.
 */
export function findModelRoot(scene: THREE.Scene): THREE.Object3D | null {
  const roots: {
    tagged?: THREE.Object3D;
    bone?: THREE.Object3D;
    skinned?: THREE.Object3D;
  } = {};

  scene.traverse((obj) => {
    if (!roots.tagged && (obj.userData?.embodyCharacterModel === true || obj.userData?.loomlargeCharacterModel === true)) {
      roots.tagged = obj;
    }
    if (!roots.bone && (obj as THREE.Bone).isBone) {
      roots.bone = obj;
    }
    if (!roots.skinned && (obj as THREE.SkinnedMesh).isSkinnedMesh) {
      roots.skinned = obj;
    }
  });

  if (roots.tagged) return roots.tagged;

  const anchor = roots.bone ?? roots.skinned;
  if (!anchor) return null;

  // Walk up to find the direct child of the scene
  let current: THREE.Object3D | null = anchor;
  while (current && current.parent && current.parent !== scene) {
    current = current.parent;
  }

  return current;
}

/**
 * Build a set of mapped bone names and a semantic key lookup
 * from an engine's profile configuration.
 */
export function buildMappedBoneInfo(profile: {
  boneNodes?: Record<string, string>;
  bonePrefix?: string;
  boneSuffix?: string;
  suffixPattern?: string;
}, actualBoneNames: Iterable<string> = []): { mappedNames: Set<string>; semanticKeyMap: Map<string, string>; semanticKeysMap: Map<string, string[]> } {
  const mappedNames = new Set<string>();
  const semanticKeyMap = new Map<string, string>();
  const semanticKeysMap = new Map<string, string[]>();
  const actualNames = Array.from(new Set(actualBoneNames));

  const boneNodes = profile.boneNodes || {};
  const prefix = profile.bonePrefix || '';
  const suffix = profile.boneSuffix || '';
  const addSemanticKey = (boneName: string, semanticKey: string) => {
    mappedNames.add(boneName);
    if (!semanticKeyMap.has(boneName)) {
      semanticKeyMap.set(boneName, semanticKey);
    }

    const existing = semanticKeysMap.get(boneName) ?? [];
    if (!existing.includes(semanticKey)) {
      semanticKeysMap.set(boneName, [...existing, semanticKey]);
    }
  };

  for (const [semanticKey, nodeName] of Object.entries(boneNodes)) {
    const fullName = prefix + nodeName + suffix;
    addSemanticKey(fullName, semanticKey);
    // Also add raw name for fuzzy matching
    if (fullName !== nodeName) {
      addSemanticKey(nodeName, semanticKey);
    }
    actualNames.forEach((actualName) => {
      if (
        fuzzyNameMatch(actualName, fullName, profile.suffixPattern)
        || fuzzyNameMatch(actualName, nodeName, profile.suffixPattern)
      ) {
        addSemanticKey(actualName, semanticKey);
      }
    });
  }

  return { mappedNames, semanticKeyMap, semanticKeysMap };
}
