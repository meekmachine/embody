import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  SkeletonOverlay,
  collectSkeletonBones,
  findModelRoot,
  resolveSkeletonOverlayStartBoneName,
} from '../../../editor/SkeletonOverlay';

function createBone(name: string): THREE.Bone {
  const bone = new THREE.Bone();
  bone.name = name;
  return bone;
}

function getVisualizationNames(overlay: SkeletonOverlay): string[] {
  return ((overlay as any).visualizations as Array<{ mesh: THREE.Mesh }>)
    .map((vis) => vis.mesh.name)
    .sort();
}

function getVisualizationMeshes(overlay: SkeletonOverlay): THREE.Mesh[] {
  return ((overlay as any).visualizations as Array<{ mesh: THREE.Mesh }>)
    .map((vis) => vis.mesh);
}

function getBoneNames(bones: THREE.Bone[]): string[] {
  return bones.map((bone) => bone.name).sort();
}

function createDomElement(width = 1000, height = 1000): HTMLElement {
  return {
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }),
  } as HTMLElement;
}

function worldToClientPoint(point: THREE.Vector3, camera: THREE.Camera, width = 1000, height = 1000): { x: number; y: number } {
  const projected = point.clone().project(camera);
  return {
    x: ((projected.x + 1) / 2) * width,
    y: ((1 - projected.y) / 2) * height,
  };
}

function projectedScreenRadius(
  origin: THREE.Vector3,
  radius: number,
  camera: THREE.Camera,
  width = 1000,
  height = 1000,
): number {
  const center = worldToClientPoint(origin, camera, width, height);
  const edge = worldToClientPoint(origin.clone().add(new THREE.Vector3(radius, 0, 0)), camera, width, height);
  return Math.hypot(edge.x - center.x, edge.y - center.y);
}

describe('SkeletonOverlay', () => {
  it('skips top-level helper root connections but keeps the rest of the rig visible', () => {
    const root = new THREE.Group();
    const helperRoot = createBone('CC_Base_BoneRoot');
    const hip = createBone('CC_Base_Hip');
    const leftLeg = createBone('LeftLeg');
    const rightLeg = createBone('RightLeg');

    hip.position.set(0, 0, 10);
    leftLeg.position.set(1, -5, 0);
    rightLeg.position.set(-1, -5, 0);

    helperRoot.add(hip);
    hip.add(leftLeg);
    hip.add(rightLeg);
    root.add(helperRoot);

    const scene = new THREE.Scene();
    scene.add(root);

    const overlay = new SkeletonOverlay(scene, new Set(), new Map());
    overlay.loadSkeleton(root);

    expect(getVisualizationNames(overlay)).toEqual([
      'bone_vis_CC_Base_Hip_LeftLeg',
      'bone_vis_CC_Base_Hip_RightLeg',
      'bone_vis_LeftLeg_leaf',
      'bone_vis_RightLeg_leaf',
    ]);

    overlay.dispose();
  });

  it('still renders top-level single-child bones that are not helper roots', () => {
    const root = new THREE.Group();
    const spine = createBone('Spine');
    const head = createBone('Head');

    head.position.set(0, 4, 0);
    spine.add(head);
    root.add(spine);

    const scene = new THREE.Scene();
    scene.add(root);

    const overlay = new SkeletonOverlay(scene, new Set(), new Map());
    overlay.loadSkeleton(root);

    expect(getVisualizationNames(overlay)).toEqual([
      'bone_vis_Head_leaf',
      'bone_vis_Spine_Head',
    ]);

    overlay.dispose();
  });

  it('skips nested helper root chains when the hip collapses into a zero-length pelvis child', () => {
    const root = new THREE.Group();
    const sceneRoot = createBone('_rootJoint');
    const helperRoot = createBone('CC_Base_BoneRoot_01');
    const hip = createBone('CC_Base_Hip_02');
    const pelvis = createBone('CC_Base_Pelvis_03');
    const leftLeg = createBone('LeftLeg');
    const rightLeg = createBone('RightLeg');

    helperRoot.position.set(0, 0, 1);
    hip.position.set(0, 0, 10);
    pelvis.position.set(0, 0, 0);
    leftLeg.position.set(1, -5, 0);
    rightLeg.position.set(-1, -5, 0);

    sceneRoot.add(helperRoot);
    helperRoot.add(hip);
    hip.add(pelvis);
    pelvis.add(leftLeg);
    pelvis.add(rightLeg);
    root.add(sceneRoot);

    const scene = new THREE.Scene();
    scene.add(root);

    const overlay = new SkeletonOverlay(scene, new Set(), new Map());
    overlay.loadSkeleton(root);

    expect(getVisualizationNames(overlay)).toEqual([
      'bone_vis_CC_Base_Pelvis_03_LeftLeg',
      'bone_vis_CC_Base_Pelvis_03_RightLeg',
      'bone_vis_LeftLeg_leaf',
      'bone_vis_RightLeg_leaf',
    ]);

    overlay.dispose();
  });

  it('starts the human skeleton view at the main body child under the helper root', () => {
    const root = new THREE.Group();
    const helperRoot = createBone('CC_Base_BoneRoot');
    const hip = createBone('CC_Base_Hip');
    const pelvis = createBone('CC_Base_Pelvis');
    const leftLeg = createBone('CC_Base_L_Thigh');
    const rightLeg = createBone('CC_Base_R_Thigh');
    const waist = createBone('CC_Base_Waist');

    helperRoot.add(hip);
    hip.add(pelvis);
    hip.add(waist);
    pelvis.add(leftLeg);
    pelvis.add(rightLeg);
    root.add(helperRoot);

    const startBoneName = resolveSkeletonOverlayStartBoneName(root);

    expect(startBoneName).toBe('CC_Base_Hip');
    expect(getBoneNames(collectSkeletonBones(root))).toEqual([
      'CC_Base_Hip',
      'CC_Base_L_Thigh',
      'CC_Base_Pelvis',
      'CC_Base_R_Thigh',
      'CC_Base_Waist',
    ]);
  });

  it('starts the T-Rex skeleton view at the main body child under the helper root', () => {
    const root = new THREE.Group();
    const armature = createBone('Armature');
    const rlBoneRoot = createBone('RL_BoneRoot');
    const trex = createBone('TRex');
    const pelvis = createBone('TRex_Pelvis');
    const leftLeg = createBone('TRex_L_Thigh');
    const rightLeg = createBone('TRex_R_Thigh');
    const eyeLeftAttachment = createBone('Eye_Left');
    const eyeRightAttachment = createBone('Eye_Right');

    armature.add(rlBoneRoot);
    rlBoneRoot.add(trex);
    rlBoneRoot.add(eyeLeftAttachment);
    rlBoneRoot.add(eyeRightAttachment);
    trex.add(pelvis);
    pelvis.add(leftLeg);
    pelvis.add(rightLeg);
    root.add(armature);

    const startBoneName = resolveSkeletonOverlayStartBoneName(root);

    expect(startBoneName).toBe('TRex');
    expect(getBoneNames(collectSkeletonBones(root))).toEqual([
      'TRex',
      'TRex_L_Thigh',
      'TRex_Pelvis',
      'TRex_R_Thigh',
    ]);

    const scene = new THREE.Scene();
    scene.add(root);

    const overlay = new SkeletonOverlay(scene, new Set(), new Map());
    overlay.loadSkeleton(root);

    expect(getVisualizationNames(overlay)).toEqual([
      'bone_vis_TRex_L_Thigh_leaf',
      'bone_vis_TRex_Pelvis_TRex_L_Thigh',
      'bone_vis_TRex_Pelvis_TRex_R_Thigh',
      'bone_vis_TRex_R_Thigh_leaf',
      'bone_vis_TRex_TRex_Pelvis',
    ]);

    overlay.dispose();
  });

  it('shows a selected-bone axis gizmo and emphasizes the focused axis', () => {
    const root = new THREE.Group();
    const spine = createBone('Spine');
    const head = createBone('Head');

    head.position.set(0, 4, 0);
    spine.add(head);
    root.add(spine);

    const scene = new THREE.Scene();
    scene.add(root);

    const overlay = new SkeletonOverlay(scene, new Set(['Head']), new Map([['Head', 'HEAD']]));
    overlay.loadSkeleton(root);
    overlay.setVisible(true);
    overlay.setSelected('Head');
    overlay.setActiveAxis('yaw');

    const gizmoGroup = (overlay as any).axisGizmoGroup as THREE.Group;
    const axisGizmoMeshes = (overlay as any).axisGizmoMeshes as Record<'pitch' | 'yaw' | 'roll', THREE.Mesh>;

    expect(gizmoGroup.visible).toBe(true);
    expect(gizmoGroup.scale.x).toBeGreaterThan(0);
    expect((axisGizmoMeshes.yaw.material as THREE.MeshBasicMaterial).opacity).toBeGreaterThan(
      (axisGizmoMeshes.pitch.material as THREE.MeshBasicMaterial).opacity,
    );
    expect(axisGizmoMeshes.yaw.scale.x).toBeGreaterThan(axisGizmoMeshes.pitch.scale.x);

    overlay.dispose();
  });

  it('keeps the selected-bone gimbal visible when skeleton lines are hidden', () => {
    const root = new THREE.Group();
    const spine = createBone('Spine');
    const head = createBone('Head');

    head.position.set(0, 4, 0);
    spine.add(head);
    root.add(spine);

    const scene = new THREE.Scene();
    scene.add(root);

    const overlay = new SkeletonOverlay(scene, new Set(['Head']), new Map([['Head', 'HEAD']]));
    overlay.loadSkeleton(root);
    overlay.setVisible(false);
    overlay.setSelected('Head');

    const gizmoGroup = (overlay as any).axisGizmoGroup as THREE.Group;

    expect(gizmoGroup.visible).toBe(true);
    expect(getVisualizationMeshes(overlay).every((mesh) => mesh.visible === false)).toBe(true);

    overlay.dispose();
  });

  it('keeps selected-bone gimbal ray targets aligned after selection updates', () => {
    const root = new THREE.Group();
    const spine = createBone('Spine');
    const head = createBone('Head');

    head.position.set(0, 1, 0);
    spine.add(head);
    root.add(spine);

    const scene = new THREE.Scene();
    scene.add(root);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
    camera.position.set(0, 1, 4);
    camera.lookAt(0, 1, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const overlay = new SkeletonOverlay(scene, new Set(['Head']), new Map([['Head', 'HEAD']]));
    overlay.loadSkeleton(root);
    overlay.setVisible(true);
    overlay.setSelected('Head');

    const domElement = createDomElement();
    const gizmoGroup = (overlay as any).axisGizmoGroup as THREE.Group;
    (overlay as any).updateAxisGizmo(camera, domElement);
    const radius = gizmoGroup.scale.x;
    const diagonal = radius / Math.SQRT2;
    const target = new THREE.Vector3(diagonal, 1 + diagonal, 0);
    const pointer = worldToClientPoint(target, camera);

    expect(overlay.pickAxisGizmo(pointer.x, pointer.y, camera, domElement)?.axis).toBe('roll');

    overlay.dispose();
  });

  it('keeps selected-bone gimbal screen size stable as the camera zooms', () => {
    const root = new THREE.Group();
    const spine = createBone('Spine');
    const head = createBone('Head');

    head.position.set(0, 1, 0);
    spine.add(head);
    root.add(spine);

    const scene = new THREE.Scene();
    scene.add(root);

    const overlay = new SkeletonOverlay(scene, new Set(['Head']), new Map([['Head', 'HEAD']]));
    overlay.loadSkeleton(root);
    overlay.setVisible(true);
    overlay.setSelected('Head');

    const domElement = createDomElement();
    const gizmoGroup = (overlay as any).axisGizmoGroup as THREE.Group;
    const origin = new THREE.Vector3(0, 1, 0);

    const nearCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
    nearCamera.position.set(0, 1, 2);
    nearCamera.lookAt(origin);
    nearCamera.updateMatrixWorld(true);
    nearCamera.updateProjectionMatrix();

    (overlay as any).updateAxisGizmo(nearCamera, domElement);
    const nearWorldRadius = gizmoGroup.scale.x;
    const nearScreenRadius = projectedScreenRadius(origin, nearWorldRadius, nearCamera);

    const farCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
    farCamera.position.set(0, 1, 6);
    farCamera.lookAt(origin);
    farCamera.updateMatrixWorld(true);
    farCamera.updateProjectionMatrix();

    (overlay as any).updateAxisGizmo(farCamera, domElement);
    const farWorldRadius = gizmoGroup.scale.x;
    const farScreenRadius = projectedScreenRadius(origin, farWorldRadius, farCamera);

    const zoomedCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 20);
    zoomedCamera.position.set(0, 1, 6);
    zoomedCamera.zoom = 2;
    zoomedCamera.lookAt(origin);
    zoomedCamera.updateMatrixWorld(true);
    zoomedCamera.updateProjectionMatrix();

    (overlay as any).updateAxisGizmo(zoomedCamera, domElement);
    const zoomedWorldRadius = gizmoGroup.scale.x;
    const zoomedScreenRadius = projectedScreenRadius(origin, zoomedWorldRadius, zoomedCamera);

    expect(farWorldRadius).toBeGreaterThan(nearWorldRadius);
    expect(zoomedWorldRadius).toBeLessThan(farWorldRadius);
    expect(nearScreenRadius).toBeCloseTo(farScreenRadius, 1);
    expect(nearScreenRadius).toBeCloseTo(zoomedScreenRadius, 1);
    expect(nearScreenRadius).toBeCloseTo(54, 0);

    overlay.dispose();
  });

  it('keeps semantic yaw and roll rings distinct even when authoring metadata remaps yaw to rz', () => {
    const root = new THREE.Group();
    const spine = createBone('Spine');
    const head = createBone('Head');

    head.position.set(0, 4, 0);
    spine.add(head);
    root.add(spine);

    const scene = new THREE.Scene();
    scene.add(root);

    const overlay = new SkeletonOverlay(scene, new Set(['Head']), new Map([['Head', 'HEAD']]));
    overlay.loadSkeleton(root);
    overlay.setVisible(true);
    overlay.setSelected('Head');

    const axisGizmoMeshes = (overlay as any).axisGizmoMeshes as Record<'pitch' | 'yaw' | 'roll', THREE.Mesh>;

    expect(axisGizmoMeshes.yaw.rotation.x).toBeCloseTo(Math.PI / 2);
    expect(axisGizmoMeshes.yaw.rotation.y).toBeCloseTo(0);
    expect(axisGizmoMeshes.roll.rotation.x).toBeCloseTo(0);
    expect(axisGizmoMeshes.roll.rotation.y).toBeCloseTo(0);

    overlay.dispose();
  });

  it.each(['embodyCharacterModel', 'loomlargeCharacterModel'])('uses the %s tagged character model root instead of helper scene bones', (tag) => {
    const scene = new THREE.Scene();
    const loaderHelper = new THREE.Group();
    const helperBone = createBone('LoaderHelperBone');
    const characterRoot = new THREE.Group();
    const characterHip = createBone('CharacterHip');

    characterRoot.userData[tag] = true;
    loaderHelper.add(helperBone);
    characterRoot.add(characterHip);
    scene.add(loaderHelper);
    scene.add(characterRoot);

    expect(findModelRoot(scene)).toBe(characterRoot);
    expect(getBoneNames(collectSkeletonBones(findModelRoot(scene)!))).toEqual(['CharacterHip']);
  });
});
