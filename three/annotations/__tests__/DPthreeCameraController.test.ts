import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DPthreeCameraController,
  resolveAutoCloseupAngle,
  resolveFocusCameraDirection,
} from '../DPthreeCameraController';

import { getWorldDirectionForCameraAngle } from '../adapter';
import { getAnnotationCameraCore, requireAnnotationCameraCore } from '../annotationCameraCore';
import * as annotationCameraMath from '../annotationCameraCore';

beforeAll(async () => { await getAnnotationCameraCore(); });

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = new THREE.Vector3();
    enableDamping = false;
    dampingFactor = 0;
    minDistance = 0;
    maxDistance = 0;
    update() {}
    dispose() {}
  },
}));

function createRotatedModel(rotationYDegrees: number): THREE.Group {
  const model = new THREE.Group();
  model.rotation.y = THREE.MathUtils.degToRad(rotationYDegrees);
  model.updateMatrixWorld(true);
  return model;
}

function createBoxModel(): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(0.8, 1.8, 0.4);
  const material = new THREE.MeshBasicMaterial();
  const model = new THREE.Mesh(geometry, material);
  model.position.y = 0.9;
  model.updateMatrixWorld(true);
  return model;
}

function createEyeModel(): { model: THREE.Group; leftEye: THREE.Bone } {
  const model = new THREE.Group();
  const body = createBoxModel();
  const leftEye = new THREE.Bone();
  const rightEye = new THREE.Bone();

  leftEye.name = 'LeftEye';
  leftEye.position.set(-0.2, 1.35, 0.12);
  rightEye.name = 'RightEye';
  rightEye.position.set(0.2, 1.35, 0.12);

  model.add(body);
  model.add(leftEye);
  model.add(rightEye);
  model.updateMatrixWorld(true);

  return { model, leftEye };
}

function createController() {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  const scene = new THREE.Scene();
  const controller = new DPthreeCameraController({
    camera,
    scene,
    domElement: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement,
    showDOMControls: false,
  });

  return { camera, scene, controller };
}

function stubMarkerLoading(controller: DPthreeCameraController): void {
  vi.spyOn(controller, 'loadMarkersForCurrentRegions').mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveFocusCameraDirection', () => {
  it('keeps the default full-body framing on world front for rotated models', () => {
    const model = createRotatedModel(180);

    const direction = resolveFocusCameraDirection(model, 0, undefined);

    expect(direction.x).toBeCloseTo(0, 5);
    expect(direction.y).toBeCloseTo(0, 5);
    expect(direction.z).toBeCloseTo(1, 5);
  });

  it('keeps explicit semantic camera angles relative to the model orientation', () => {
    const model = createRotatedModel(180);

    const direction = resolveFocusCameraDirection(model, 90, 90);

    expect(direction.x).toBeCloseTo(-1, 5);
    expect(direction.y).toBeCloseTo(0, 5);
    expect(direction.z).toBeCloseTo(0, 5);
  });

  it('keeps auto-angled closeups relative to the model orientation', () => {
    const model = createRotatedModel(180);

    const direction = resolveFocusCameraDirection(model, 25, undefined);
    const expected = getWorldDirectionForCameraAngle(model, 25);

    expect(direction.distanceTo(expected)).toBeLessThan(1e-6);
  });

  it('supports world-space auto-angles for rotated closeups', () => {
    const model = createRotatedModel(180);

    const direction = resolveFocusCameraDirection(model, 25, undefined, 'world');

    expect(direction.x).toBeCloseTo(0.4226182617, 5);
    expect(direction.y).toBeCloseTo(0, 5);
    expect(direction.z).toBeCloseTo(0.9063077870, 5);
  });

  it('supports world-space intro angles for rotated models', () => {
    const model = createRotatedModel(180);

    const direction = resolveFocusCameraDirection(model, -30, -30, 'world');

    expect(direction.x).toBeCloseTo(-0.5, 5);
    expect(direction.y).toBeCloseTo(0, 5);
    expect(direction.z).toBeCloseTo(Math.sqrt(3) / 2, 5);
  });
});

describe('resolveAutoCloseupAngle', () => {
  it('uses model depth rather than width for humanoid-style closeups', () => {
    const angle = resolveAutoCloseupAngle(
      0.2,
      new THREE.Vector3(0.08, 0.08, 0.08),
      new THREE.Vector3(1.8, 1.8, 0.4)
    );

    expect(angle).toBeCloseTo(68.1985905, 5);
  });

  it('skips auto-angle for larger targets', () => {
    const angle = resolveAutoCloseupAngle(
      0.2,
      new THREE.Vector3(0.3, 0.3, 0.3),
      new THREE.Vector3(1.8, 1.8, 0.4)
    );

    expect(angle).toBeUndefined();
  });
});

describe('camera animation timer fallback', () => {
  it('drives animations by timer when no renderer loop is managed', () => {
    const { controller } = createController();

    expect((controller as any).shouldDriveTimerAnimationFallback()).toBe(true);
  });

  it('does not double-drive animations while a visible renderer loop is active', () => {
    const { controller } = createController();
    (controller as any).renderer = {};
    vi.stubGlobal('document', { hidden: false });

    expect((controller as any).shouldDriveTimerAnimationFallback()).toBe(false);
  });

  it('leaves hidden renderer-managed animations to the renderer loop lifecycle', () => {
    const { controller } = createController();
    (controller as any).renderer = {};
    vi.stubGlobal('document', { hidden: true });

    expect((controller as any).shouldDriveTimerAnimationFallback()).toBe(false);
  });
});

describe('full-body framing', () => {
  it('frames full-body focus larger with crop pressure toward the feet', async () => {
    const { camera, scene, controller } = createController();
    const model = createBoxModel();

    scene.add(model);
    controller.setModel(model);

    await controller.focusFullBody(0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const topY = new THREE.Vector3(0, 1.8, 0).project(camera).y;
    const centerY = new THREE.Vector3(0, 0.9, 0).project(camera).y;
    const bottomY = new THREE.Vector3(0, 0, 0).project(camera).y;

    expect(controller.controls.target.y).toBeGreaterThan(0.95);
    expect(topY).toBeGreaterThan(0.65);
    expect(centerY).toBeLessThan(0);
    expect(bottomY).toBeLessThan(-0.8);
    expect(bottomY).toBeGreaterThan(-0.95);
  });

  it('settles intro loads into a tighter left-eye closeup when available', async () => {
    const { scene, controller } = createController();
    const { model, leftEye } = createEyeModel();
    const leftEyePosition = new THREE.Vector3();
    leftEye.getWorldPosition(leftEyePosition);

    scene.add(model);
    controller.setModel(model);
    (controller as any).regions = [
      {
        name: 'left_eye',
        bones: ['LeftEye'],
        paddingFactor: 1.2,
        parent: 'head',
      },
      {
        name: 'full_body',
        objects: ['*'],
        paddingFactor: 2,
      },
    ];

    const animateOrbitSpy = vi.spyOn(controller as any, 'animateOrbit').mockResolvedValue(undefined);
    const animateCameraSpy = vi.spyOn(controller as any, 'animateCamera').mockResolvedValue(undefined);

    await controller.playIntroAnimation(250, 400);

    expect(animateOrbitSpy).toHaveBeenCalledOnce();
    expect(animateCameraSpy).toHaveBeenCalledOnce();

    const [position, target, duration] = animateCameraSpy.mock.calls[0] as [
      THREE.Vector3,
      THREE.Vector3,
      number,
    ];

    expect(duration).toBe(400);
    expect(target.x).toBeCloseTo(leftEyePosition.x, 5);
    expect(target.y).toBeLessThan(leftEyePosition.y);
    expect(target.y).toBeGreaterThan(1.25);
    expect(position.x).toBeLessThan(target.x);
    expect(position.distanceTo(target)).toBeLessThan(1);
  });
});

describe('annotation focus targets', () => {
  it('can focus an explicit point separately from the marker region targets', async () => {
    const { scene, controller } = createController();
    const model = createBoxModel();

    scene.add(model);
    controller.setModel(model);
    (controller as any).regions = [
      {
        name: 'left_eye',
        bones: ['LeftEye'],
        focusTarget: {
          type: 'point',
          position: { x: 0.25, y: 1.35, z: 0.18 },
          paddingFactor: 0.7,
        },
      },
    ];

    const animateCameraSpy = vi.spyOn(controller as any, 'animateCamera').mockResolvedValue(undefined);

    await controller.focusRegion('left_eye', 0);

    expect(animateCameraSpy).toHaveBeenCalledOnce();
    const [, target] = animateCameraSpy.mock.calls[0] as [THREE.Vector3, THREE.Vector3, number];

    expect(target.x).toBeCloseTo(0.25, 5);
    expect(target.y).toBeCloseTo(1.35, 5);
    expect(target.z).toBeCloseTo(0.18, 5);
  });

  it('can focus a bone target even when the marker region targets a mesh', async () => {
    const { scene, controller } = createController();
    const model = new THREE.Group();
    const body = createBoxModel();
    const jaw = new THREE.Bone();

    jaw.name = 'Jaw';
    jaw.position.set(0, 1.1, 0.25);
    model.add(body);
    model.add(jaw);
    model.updateMatrixWorld(true);

    scene.add(model);
    controller.setModel(model);
    (controller as any).regions = [
      {
        name: 'mouth',
        meshes: ['BodyMesh'],
        focusTarget: {
          type: 'bone',
          bones: ['Jaw'],
          paddingFactor: 0.75,
        },
      },
    ];

    const animateCameraSpy = vi.spyOn(controller as any, 'animateCamera').mockResolvedValue(undefined);

    await controller.focusRegion('mouth', 0);

    expect(animateCameraSpy).toHaveBeenCalledOnce();
    const [, target] = animateCameraSpy.mock.calls[0] as [THREE.Vector3, THREE.Vector3, number];

    expect(target.x).toBeCloseTo(0, 5);
    expect(target.y).toBeCloseTo(1.1, 5);
    expect(target.z).toBeCloseTo(0.25, 5);
  });

  it('can focus a face-center target without requiring a face-like region name', async () => {
    const { scene, controller } = createController();
    const model = new THREE.Group();
    const body = createBoxModel();
    const faceMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.16, 0.08),
      new THREE.MeshBasicMaterial()
    );

    faceMesh.name = 'FaceMesh';
    faceMesh.position.set(0, 1.4, 0.24);
    model.add(body);
    model.add(faceMesh);
    model.updateMatrixWorld(true);

    scene.add(model);
    controller.setModel(model);
    (controller as any).regions = [
      {
        name: 'expression_driver',
        focusTarget: {
          type: 'face-center',
          meshes: ['FaceMesh'],
          paddingFactor: 0.65,
        },
      },
    ];

    const animateCameraSpy = vi.spyOn(controller as any, 'animateCamera').mockResolvedValue(undefined);

    await controller.focusRegion('expression_driver', 0);

    expect(animateCameraSpy).toHaveBeenCalledOnce();
    const [, target] = animateCameraSpy.mock.calls[0] as [THREE.Vector3, THREE.Vector3, number];

    expect(target.x).toBeCloseTo(0, 5);
    expect(target.y).toBeCloseTo(1.4, 5);
    expect(target.z).toBeCloseTo(0.24, 5);

    faceMesh.geometry.dispose();
  });
});

describe('annotation region runtime updates', () => {
  it('finishes marker preparation before starting the intro camera transition', async () => {
    const { controller } = createController();
    let finishMarkerLoad: (() => void) | undefined;
    const markerLoad = new Promise<void>((resolve) => {
      finishMarkerLoad = resolve;
    });
    const loadMarkers = vi
      .spyOn(controller, 'loadMarkersForCurrentRegions')
      .mockImplementation(() => markerLoad);
    const playIntro = vi
      .spyOn(controller, 'playIntroAnimation')
      .mockResolvedValue(undefined);
    const config = {
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      playIntroOnLoad: true,
      regions: [],
    };

    const preparation = controller.prepareRegionsAndMarkersForReveal(config);

    expect(loadMarkers).toHaveBeenCalledOnce();
    expect(playIntro).not.toHaveBeenCalled();

    finishMarkerLoad?.();
    await preparation;

    expect(playIntro).toHaveBeenCalledOnce();
  });

  it('awaits preset expansion before loading camera regions', async () => {
    const { controller } = createController();
    stubMarkerLoading(controller);

    await controller.loadRegions({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      auPresetType: 'cc4',
      regions: [],
    });

    expect(controller.getCharacterConfig()?.regions.length).toBeGreaterThan(0);
    expect(controller.getRegionNames()).toContain('head');
  });

  it('waits for GPU preparation and skips the intro when that load becomes stale', async () => {
    const { controller } = createController();
    vi.spyOn(controller, 'loadMarkersForCurrentRegions').mockResolvedValue(undefined);
    const intro = vi.spyOn(controller, 'playIntroAnimation').mockResolvedValue(undefined);
    let finishWarmup: (current: boolean) => void = () => undefined;
    const warmup = vi.fn(() => new Promise<boolean>((resolve) => { finishWarmup = resolve; }));
    const preparation = controller.prepareRegionsAndMarkersForReveal({
      characterId: 'test', characterName: 'Test', modelPath: 'test.glb',
      playIntroOnLoad: true, regions: [],
    }, warmup);
    await Promise.resolve();
    expect(warmup).toHaveBeenCalledOnce();
    expect(intro).not.toHaveBeenCalled();
    finishWarmup(false);
    await preparation;
    expect(intro).not.toHaveBeenCalled();
  });

  it('adds a new annotation region to the active runtime config', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });

    controller.updateAnnotationRegion('left_eye', {
      bones: ['LeftEye'],
      parent: 'head',
      paddingFactor: 0.8,
    });

    expect(controller.getAnnotationRegion('left_eye')).toMatchObject({
      name: 'left_eye',
      bones: ['LeftEye'],
      parent: 'head',
      paddingFactor: 0.8,
    });
    expect(controller.getRegionNames()).toEqual(['full_body', 'left_eye']);
  });

  it('removes a runtime-only annotation region', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
        {
          name: 'left_eye',
          bones: ['LeftEye'],
          paddingFactor: 0.8,
        },
      ],
    });

    controller.removeAnnotationRegion('left_eye');

    expect(controller.getAnnotationRegion('left_eye')).toBeUndefined();
    expect(controller.getRegionNames()).toEqual(['full_body']);
  });

  it('creates a runtime bone annotation with explicit marker and focus anchors', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const summary = controller.showRuntimeBoneAnnotation('HEAD', {
      markerColor: 0xffaa00,
      lineColor: 0xffaa00,
      paddingFactor: 0.7,
      projectToSurface: false,
    });

    expect(summary).toEqual({
      name: 'runtime:annotation:bone:HEAD:bone:HEAD',
      label: 'Bone: HEAD',
      targetType: 'bone',
      target: 'HEAD',
      bones: ['HEAD'],
    });
    expect(controller.getMarkersVisible()).toBe(true);
    expect(controller.getAnnotationRegion(summary.name)).toMatchObject({
      name: summary.name,
      label: 'Bone: HEAD',
      bones: ['HEAD'],
      paddingFactor: 0.7,
      markerAnchor: {
        type: 'bone',
        bones: ['HEAD'],
        projectToSurface: false,
      },
      focusTarget: {
        type: 'bone',
        bones: ['HEAD'],
        paddingFactor: 0.7,
      },
      runtimeAnnotation: {
        targetType: 'bone',
        target: 'HEAD',
        boneName: 'HEAD',
      },
      style: {
        markerColor: 0xffaa00,
        lineColor: 0xffaa00,
      },
    });
  });

  it('creates one runtime annotation per unique AU bone binding', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const summaries = controller.showRuntimeAUAnnotations(12, {
      auToBones: {
        12: [
          { node: 'MOUTH_L', channel: 'ry', scale: 1 },
          { node: 'MOUTH_R', channel: 'ry', scale: -1 },
          { node: 'MOUTH_L', channel: 'rz', scale: 0.5 },
        ],
      },
    }, {
      label: 'Smile',
      markerColor: 0x00d1b2,
    });

    expect(summaries).toEqual([
      {
        name: 'runtime:annotation:au:12:bone:MOUTH_L',
        label: 'Smile: MOUTH_L',
        targetType: 'au',
        target: '12',
        bones: ['MOUTH_L'],
      },
      {
        name: 'runtime:annotation:au:12:bone:MOUTH_R',
        label: 'Smile: MOUTH_R',
        targetType: 'au',
        target: '12',
        bones: ['MOUTH_R'],
      },
    ]);
    expect(controller.getAnnotationRegion(summaries[0].name)).toMatchObject({
      markerAnchor: {
        type: 'bone',
        bones: ['MOUTH_L'],
      },
      runtimeAnnotation: {
        targetType: 'au',
        target: '12',
        boneName: 'MOUTH_L',
      },
      style: {
        markerColor: 0x00d1b2,
      },
    });
    expect(controller.getAnnotationRegion(summaries[1].name)).toMatchObject({
      markerAnchor: {
        type: 'bone',
        bones: ['MOUTH_R'],
      },
    });
  });

  it('creates runtime mesh annotations for AU morph targets when the engine reports owning meshes', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const summaries = controller.showRuntimeAUAnnotations(12, {
      auToMorphs: {
        12: {
          left: ['Smile_L'],
          right: ['Smile_R'],
          center: [],
        },
      },
    }, {
      label: 'Smile',
      lineColor: 0x00d1b2,
    }, {
      FaceMesh: ['Smile_L', 'Smile_R', 'Blink_L'],
    });

    expect(summaries).toEqual([
      {
        name: 'runtime:annotation:au:12:mesh:FaceMesh',
        label: 'Smile: FaceMesh',
        targetType: 'au',
        target: '12',
        bones: [],
        meshes: ['FaceMesh'],
        morphs: ['Smile_L', 'Smile_R'],
      },
    ]);
    expect(controller.getAnnotationRegion(summaries[0].name)).toMatchObject({
      meshes: ['FaceMesh'],
      markerAnchor: {
        type: 'mesh',
        meshes: ['FaceMesh'],
      },
      focusTarget: {
        type: 'mesh',
        meshes: ['FaceMesh'],
      },
      runtimeAnnotation: {
        targetType: 'au',
        target: '12',
        meshName: 'FaceMesh',
        morphNames: ['Smile_L', 'Smile_R'],
      },
      style: {
        lineColor: 0x00d1b2,
      },
    });
  });

  it('can limit runtime AU annotations for concise interactive previews', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const summaries = controller.showRuntimeAUAnnotations(12, {
      auToBones: {
        12: [
          { node: 'MOUTH_L', channel: 'ry', scale: 1 },
          { node: 'MOUTH_R', channel: 'ry', scale: -1 },
        ],
      },
      auToMorphs: {
        12: ['Smile_L'],
      },
    }, {
      label: 'Smile',
      maxTargets: 1,
    }, {
      FaceMesh: ['Smile_L'],
    });

    expect(summaries).toEqual([
      {
        name: 'runtime:annotation:au:12:bone:MOUTH_L',
        label: 'Smile: MOUTH_L',
        targetType: 'au',
        target: '12',
        bones: ['MOUTH_L'],
      },
    ]);
  });

  it('can target one AU morph side for interactive previews', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const summaries = controller.showRuntimeAUAnnotations(12, {
      auToMorphs: {
        12: {
          left: ['Smile_L'],
          right: ['Smile_R'],
          center: [],
        },
      },
    }, {
      label: 'Smile',
      maxTargets: 1,
      targetSide: 'right',
    }, {
      FaceMesh: ['Smile_L', 'Smile_R'],
    });

    expect(summaries).toEqual([
      {
        name: 'runtime:annotation:au:12:right:mesh:FaceMesh',
        label: 'Smile: FaceMesh',
        targetType: 'au',
        target: '12',
        bones: [],
        meshes: ['FaceMesh'],
        morphs: ['Smile_R'],
        side: 'right',
      },
    ]);
    expect(controller.getAnnotationRegion(summaries[0].name)).toMatchObject({
      markerAnchor: {
        type: 'mesh',
        meshes: ['FaceMesh'],
      },
      runtimeAnnotation: {
        targetType: 'au',
        target: '12',
        meshName: 'FaceMesh',
        morphNames: ['Smile_R'],
        side: 'right',
      },
    });
  });

  it('prefers eyebrow meshes for brow AU morph previews', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const summaries = controller.showRuntimeAUAnnotations(1, {
      auToMorphs: {
        1: {
          left: ['Brow_Raise_Inner_L'],
          right: ['Brow_Raise_Inner_R'],
          center: [],
        },
      },
    }, {
      label: 'Inner Brow Raiser',
      maxTargets: 1,
      targetPreference: 'mesh',
      targetSide: 'left',
    }, {
      CC_Base_Body_1: ['Brow_Raise_Inner_L', 'Brow_Raise_Inner_R'],
      Male_Bushy_1: ['Brow_Raise_Inner_L', 'Brow_Raise_Inner_R'],
    });

    expect(summaries).toEqual([
      {
        name: 'runtime:annotation:au:1:left:mesh:Male_Bushy_1',
        label: 'Inner Brow Raiser: Male_Bushy_1',
        targetType: 'au',
        target: '1',
        bones: [],
        meshes: ['Male_Bushy_1'],
        morphs: ['Brow_Raise_Inner_L'],
        side: 'left',
      },
    ]);
  });

  it('can prefer AU bone targets for node-backed continuum previews', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const summaries = controller.showRuntimeAUAnnotations(52, {
      auToBones: {
        52: [{ node: 'CC_Base_Head', channel: 'ry', scale: -1 }],
      },
      auToMorphs: {
        52: {
          left: [],
          right: ['Head_Turn_R'],
          center: [],
        },
      },
    }, {
      label: 'Head Turn Right',
      maxTargets: 1,
      targetPreference: 'bone',
      targetSide: 'right',
    }, {
      CC_Base_Body_1: ['Head_Turn_R'],
    });

    expect(summaries).toEqual([
      {
        name: 'runtime:annotation:au:52:right:bone:CC_Base_Head',
        label: 'Head Turn Right: CC_Base_Head',
        targetType: 'au',
        target: '52',
        bones: ['CC_Base_Head'],
        side: 'right',
      },
    ]);
  });

  it('replaces the opposite AU side when showing a side-targeted preview', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const profile = {
      auToMorphs: {
        12: {
          left: ['Smile_L'],
          right: ['Smile_R'],
          center: [],
        },
      },
    };
    const morphTargetsByMesh = {
      FaceMesh: ['Smile_L', 'Smile_R'],
    };

    controller.showRuntimeAUAnnotations(12, profile, {
      label: 'Smile',
      maxTargets: 1,
      targetSide: 'left',
    }, morphTargetsByMesh);
    const rightSummaries = controller.showRuntimeAUAnnotations(12, profile, {
      label: 'Smile',
      maxTargets: 1,
      targetSide: 'right',
    }, morphTargetsByMesh);

    expect(rightSummaries).toEqual([
      {
        name: 'runtime:annotation:au:12:right:mesh:FaceMesh',
        label: 'Smile: FaceMesh',
        targetType: 'au',
        target: '12',
        bones: [],
        meshes: ['FaceMesh'],
        morphs: ['Smile_R'],
        side: 'right',
      },
    ]);
    expect(controller.getAnnotationRegion('runtime:annotation:au:12:left:mesh:FaceMesh')).toBeUndefined();
    expect(controller.getAnnotationRegion('runtime:annotation:au:12:right:mesh:FaceMesh')).toMatchObject({
      runtimeAnnotation: {
        targetType: 'au',
        target: '12',
        meshName: 'FaceMesh',
        morphNames: ['Smile_R'],
        side: 'right',
      },
    });
    expect(controller.getRegionNames()).toEqual([
      'full_body',
      'runtime:annotation:au:12:right:mesh:FaceMesh',
    ]);
  });

  it('can keep runtime AU previews exclusive across different sliders', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const profile = {
      auToBones: {
        1: [{ node: 'BROW_L', channel: 'rx', scale: 1 }],
        12: [{ node: 'MOUTH_R', channel: 'ry', scale: 1 }],
      },
    };

    controller.showRuntimeAUAnnotations(1, profile, {
      label: 'Brow',
      maxTargets: 1,
      targetSide: 'left',
      replaceExisting: true,
    });
    const smileSummaries = controller.showRuntimeAUAnnotations(12, profile, {
      label: 'Smile',
      maxTargets: 1,
      targetSide: 'right',
      replaceExisting: true,
    });

    expect(smileSummaries).toEqual([
      {
        name: 'runtime:annotation:au:12:right:bone:MOUTH_R',
        label: 'Smile: MOUTH_R',
        targetType: 'au',
        target: '12',
        bones: ['MOUTH_R'],
        side: 'right',
      },
    ]);
    expect(controller.getAnnotationRegion('runtime:annotation:au:1:left:bone:BROW_L')).toBeUndefined();
    expect(controller.getRegionNames()).toEqual([
      'full_body',
      'runtime:annotation:au:12:right:bone:MOUTH_R',
    ]);
  });

  it('clears only runtime annotation regions', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      auToBones: {
        51: [{ node: 'HEAD', channel: 'ry', scale: 1 }],
      },
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });
    stubMarkerLoading(controller);

    const summaries = controller.showRuntimeAUAnnotations(51);
    const removed = controller.clearRuntimeAnnotations();

    expect(removed).toEqual(summaries.map((summary) => summary.name));
    expect(controller.getRegionNames()).toEqual(['full_body']);
    expect(controller.getAnnotationRegion('full_body')).toBeDefined();
  });

  it('reports an unmapped AU instead of creating an empty annotation', () => {
    const { controller } = createController();

    controller.prepareRegionsForReveal({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        {
          name: 'full_body',
          objects: ['*'],
          paddingFactor: 2,
        },
      ],
    });

    expect(() => controller.showRuntimeAUAnnotations(999)).toThrow(
      'AU 999 has no bone or morph bindings to annotate',
    );
    expect(controller.getRegionNames()).toEqual(['full_body']);
  });
});


describe('Rust camera animation lifecycle', () => {
  it('samples a Rust flight and releases it when the exact destination is reached', async () => {
    const { camera, controller } = createController();
    (controller as any).renderer = { setAnimationLoop: vi.fn() };
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const factory = vi.spyOn(requireAnnotationCameraCore(), 'createCameraFlight');
    const destination = new THREE.Vector3(-3, 1, 0);
    const target = new THREE.Vector3(0, 1, 0);
    const completion = (controller as any).animateCamera(destination, target, 1000);
    const runtime = factory.mock.results[0].value;
    const dispose = vi.spyOn(runtime, 'dispose');

    clock.mockReturnValue(500);
    controller.update();
    expect(camera.position.distanceTo(target)).toBeGreaterThan(3);
    expect(camera.position.x).toBeLessThan(0);
    expect(camera.position.z).toBeGreaterThan(0);
    expect(dispose).not.toHaveBeenCalled();

    clock.mockReturnValue(1000);
    controller.update();
    await completion;
    expect(camera.position.distanceTo(destination)).toBeLessThan(1e-5);
    expect(controller.controls.target.equals(target)).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    controller.update();
    controller.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('frees a superseded flight and immediately completes zero-duration flights', async () => {
    const { camera, controller } = createController();
    (controller as any).renderer = { setAnimationLoop: vi.fn() };
    const factory = vi.spyOn(requireAnnotationCameraCore(), 'createCameraFlight');
    const first = (controller as any).animateCamera(new THREE.Vector3(3, 2, 1), new THREE.Vector3(), 1000);
    const firstDispose = vi.spyOn(factory.mock.results[0].value, 'dispose');
    const destination = new THREE.Vector3(0, 2, 4);
    await (controller as any).animateCamera(destination, new THREE.Vector3(0, 2, 0), 0);
    await first;
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(camera.position.equals(destination)).toBe(true);
    expect((controller as any).pendingAnimation).toBeNull();
    controller.dispose();
  });

  it.each(['dispose', 'clearMarkers'] as const)(
    'releases an active orbit on %s without continuing the intro landing', async (reset) => {
    const { controller, scene } = createController();
    (controller as any).renderer = { setAnimationLoop: vi.fn() };
    const model = createBoxModel();
    scene.add(model);
    controller.setModel(model);
    const factory = vi.spyOn(requireAnnotationCameraCore(), 'createCameraOrbit');
    const landing = vi.spyOn(requireAnnotationCameraCore(), 'createCameraFlight');
    const introduction = controller.playIntroAnimation(1000, 500);
    await Promise.resolve();
    await Promise.resolve();
    const dispose = vi.spyOn(factory.mock.results[0].value, 'dispose');

    controller[reset]();
    await introduction;
    expect(dispose).toHaveBeenCalledOnce();
    expect(landing).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('cancels a flight and settles its promise when the character changes', async () => {
    const { controller } = createController();
    (controller as any).renderer = { setAnimationLoop: vi.fn() };
    const factory = vi.spyOn(requireAnnotationCameraCore(), 'createCameraFlight');
    const flight = (controller as any).animateCamera(new THREE.Vector3(3, 2, 1), new THREE.Vector3(), 1000);
    const dispose = vi.spyOn(factory.mock.results[0].value, 'dispose');

    controller.setModel(createBoxModel());
    await flight;
    expect(dispose).toHaveBeenCalledOnce();
    expect((controller as any).pendingAnimation).toBeNull();
    controller.dispose();
  });

  it('abandons a focus request when its model changes while Wasm readiness is pending', async () => {
    const { controller, camera } = createController();
    controller.setModel(createBoxModel());
    const initialPosition = camera.position.clone();
    let finishInitialization!: (core: ReturnType<typeof requireAnnotationCameraCore>) => void;
    const initialization = new Promise<ReturnType<typeof requireAnnotationCameraCore>>((resolve) => {
      finishInitialization = resolve;
    });
    vi.spyOn(annotationCameraMath, 'getAnnotationCameraCore').mockReturnValueOnce(initialization);
    const focus = controller.focusFullBody(0);

    controller.setModel(createBoxModel());
    finishInitialization(requireAnnotationCameraCore());
    await focus;
    expect(camera.position.equals(initialPosition)).toBe(true);
    controller.dispose();
  });

  it('abandons a captured region focus when regions are cleared during Wasm initialization', async () => {
    const { controller, camera } = createController();
    controller.setModel(createBoxModel());
    (controller as any).regions = [{ name: 'full_body', objects: ['*'] }];
    const initialPosition = camera.position.clone();
    const flight = vi.spyOn(requireAnnotationCameraCore(), 'createCameraFlight');
    let finishInitialization!: (core: ReturnType<typeof requireAnnotationCameraCore>) => void;
    const initialization = new Promise<ReturnType<typeof requireAnnotationCameraCore>>((resolve) => {
      finishInitialization = resolve;
    });
    vi.spyOn(annotationCameraMath, 'getAnnotationCameraCore').mockReturnValueOnce(initialization);
    const focus = controller.focusRegion('full_body', 0);

    controller.clearMarkers();
    finishInitialization(requireAnnotationCameraCore());
    await focus;
    expect(camera.position.equals(initialPosition)).toBe(true);
    expect(controller.getCurrentRegion()).toBeNull();
    expect(flight).not.toHaveBeenCalled();
    controller.dispose();
  });
});
