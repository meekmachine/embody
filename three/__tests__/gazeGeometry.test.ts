import { Bone, Group, PerspectiveCamera, Scene } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { solveGazeGeometry, solveGazeBindingTargets, mapGazeAnglesToBindingTargets } from '@lovelace_lol/embody/wasm';
import type { GazeAxis, GazeClipBinding } from '@lovelace_lol/embody/wasm';
import { Embody } from '../character';
import { createGazeGeometryObservationSource } from '../gazeGeometry';
import type { GazeGeometryObservation } from '../gazeGeometry';
import { publishSceneObservations } from '../sceneObservations';
import authoredRig from './fixtures/cc4GazeRig.json';

function fixture() {
  const model = new Group(), head = new Bone(), left = new Bone(), right = new Bone();
  head.name = 'Head'; left.name = 'LeftEye'; right.name = 'RightEye';
  head.position.y = 1.6; left.position.x = 0.1; right.position.x = -0.1;
  model.add(head); head.add(left, right);
  const engine = new Embody({ profileMode: 'profile', profile: {
    boneNodes: { head: 'Head', leftEye: 'LeftEye', rightEye: 'RightEye' },
    humanoidCharacterization: { schemaVersion: 1, standard: 'VRMC_vrm-1.0', status: 'characterized', roles: {
      head: { nodeKey: 'head' }, leftEye: { nodeKey: 'leftEye' }, rightEye: { nodeKey: 'rightEye' },
    } },
    auToBones: {
      8001: [{ node: 'head', channel: 'ry', scale: 1, maxDegrees: 60 }],
      8002: [{ node: 'head', channel: 'ry', scale: -1, maxDegrees: 60 }],
      9001: [{ node: 'leftEye', channel: 'ry', scale: 1, maxDegrees: 25 }, { node: 'rightEye', channel: 'ry', scale: 1, maxDegrees: 25 }],
      9002: [{ node: 'leftEye', channel: 'ry', scale: -1, maxDegrees: 25 }, { node: 'rightEye', channel: 'ry', scale: -1, maxDegrees: 25 }],
    },
    compositeRotations: [
      { node: 'head', yaw: { axis: 'ry', aus: [], negative: 8001, positive: 8002 }, pitch: null, roll: null },
      { node: 'leftEye', yaw: { axis: 'ry', aus: [], negative: 9001, positive: 9002 }, pitch: null, roll: null },
      { node: 'rightEye', yaw: { axis: 'ry', aus: [], negative: 9001, positive: 9002 }, pitch: null, roll: null },
    ],
  } });
  engine.onReady({ model });
  const scene = new Scene(); scene.add(model);
  const camera = new PerspectiveCamera(60, 1.5, 0.01, 100); camera.position.set(0, 1.6, 5);
  const binding = (negative: number, positive: number): GazeClipBinding => ({ negativeTimeSec: 0, neutralTimeSec: 1, positiveTimeSec: 2,
    snippet: { duration: 2, curves: {
      [negative]: [{ time: 0, intensity: 1 }, { time: 1, intensity: 0 }, { time: 2, intensity: 0 }],
      [positive]: [{ time: 0, intensity: 0 }, { time: 1, intensity: 0 }, { time: 2, intensity: 1 }],
    } } });
  const bindings: Partial<Record<GazeAxis, GazeClipBinding>> = { headYaw: binding(8001, 8002), eyeYaw: binding(9001, 9002) };
  return { model, head, engine, scene, camera, bindings };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('dedicated camera-relative character geometry', () => {
  it('calibrates the authored CC4 head and eye basis including eye-local Rz yaw', () => {
    // Numeric hierarchy from the actual asset recorded by source/sha256 in the
    // fixture. No renderer or optical-axis guess replaces its rest transforms.
    const model = new Group(), nodes = new Map<string, Group | Bone>();
    for (const spec of authoredRig.nodes) {
      const node = spec.kind === 'bone' ? new Bone() : new Group(); node.name = spec.name;
      if ('translation' in spec) node.position.fromArray(spec.translation!);
      if ('rotation' in spec) node.quaternion.fromArray(spec.rotation!);
      if ('scale' in spec) node.scale.fromArray(spec.scale!);
      nodes.set(spec.name, node);
    }
    for (const spec of authoredRig.nodes) (spec.parent === null ? model : nodes.get(spec.parent)!).add(nodes.get(spec.name)!);
    const engine = new Embody({ presetType: 'cc4' }); engine.onReady({ model });
    try {
      const bind = (negative: number, positive: number): GazeClipBinding => ({ negativeTimeSec: 0, neutralTimeSec: 1, positiveTimeSec: 2,
        snippet: { duration: 2, curves: {
          [negative]: [{ time: 0, intensity: 1 }, { time: 1, intensity: 0 }, { time: 2, intensity: 0 }],
          [positive]: [{ time: 0, intensity: 0 }, { time: 1, intensity: 0 }, { time: 2, intensity: 1 }],
        } } });
      const calibration = engine.getGazeBindingCalibration({ headYaw: bind(51, 52), headPitch: bind(54, 53), headRoll: bind(55, 56),
        eyeYaw: bind(61, 62), eyePitch: bind(64, 63) });
      for (const axis of ['headYaw', 'headPitch', 'headRoll', 'eyeYaw', 'eyePitch'] as const) {
        expect(calibration[axis], axis).toMatchObject({ available: true });
        expect(calibration[axis]?.samples[0].angleDegrees, axis).toBeLessThan(0);
        expect(calibration[axis]?.samples.at(-1)?.angleDegrees, axis).toBeGreaterThan(0);
      }
      expect(calibration.eyeYaw?.samples.at(-1)?.angleDegrees).toBeCloseTo(25);
      expect(mapGazeAnglesToBindingTargets(calibration, { eyeYaw: 12.5 }).targets.eyeYaw).toBeCloseTo(0.5);
    } finally { engine.dispose(); }
  });
  it('uses the eye-to-camera bearing and rotated character frame without annotations', () => {
    const f = fixture();
    try {
      f.model.position.x = 2;
      const facts = f.engine.getGazeGeometryFacts(f.camera);
      const result = solveGazeGeometry({ ...facts, target: { kind: 'screen', x: 0, y: 0 } });
      expect(result.targetAnglesDegrees.yaw).toBeCloseTo(Math.atan2(2, 5) * 180 / Math.PI);
      f.model.rotation.y = Math.PI / 2;
      expect(solveGazeGeometry({ ...f.engine.getGazeGeometryFacts(f.camera), target: { kind: 'screen', x: 0, y: 0 } }).targetAnglesDegrees.yaw)
        .toBeCloseTo(result.targetAnglesDegrees.yaw + 90);
    } finally { f.engine.dispose(); }
  });
  it('includes zoom in effective FOV and rejects reflected/nonuniform geometry', () => {
    const f = fixture();
    try {
      const original = solveGazeGeometry({ ...f.engine.getGazeGeometryFacts(f.camera), target: { kind: 'screen', x: 1, y: 0 } });
      f.camera.zoom = 2; f.camera.updateProjectionMatrix();
      const zoomed = solveGazeGeometry({ ...f.engine.getGazeGeometryFacts(f.camera), target: { kind: 'screen', x: 1, y: 0 } });
      expect(Math.abs(zoomed.targetAnglesDegrees.yaw)).toBeLessThan(Math.abs(original.targetAnglesDegrees.yaw));
      f.model.scale.setScalar(2); f.camera.position.multiplyScalar(2);
      expect(solveGazeGeometry({ ...f.engine.getGazeGeometryFacts(f.camera), target: { kind: 'screen', x: 1, y: 0 } }).targetAnglesDegrees.yaw)
        .toBeCloseTo(zoomed.targetAnglesDegrees.yaw);
      f.model.scale.set(1, 2, 1); expect(() => f.engine.getGazeGeometryFacts(f.camera)).toThrow('uniform');
      f.model.scale.set(-1, 1, 1); expect(() => f.engine.getGazeGeometryFacts(f.camera)).toThrow('uniform');
    } finally { f.engine.dispose(); }
  });
  it('calibrates saved custom IDs and allocates one target across head and eyes', () => {
    const f = fixture();
    try {
      const calibration = f.engine.getGazeBindingCalibration(f.bindings);
      expect(calibration.headYaw?.available).toBe(true); expect(calibration.eyeYaw?.available).toBe(true);
      expect(mapGazeAnglesToBindingTargets(calibration, { headYaw: 30 }).targets.headYaw).toBeCloseTo(0.5);
      const result = solveGazeBindingTargets(calibration, { headAnglesDegrees: { yaw: 30, pitch: 0, roll: 0 },
        eyeAnglesDegrees: { yaw: 30, pitch: 0 }, headEnabled: true, eyesEnabled: true, headIntensity: 0.5, eyeIntensity: 1, intensity: 1 });
      expect(result.targets.headYaw).toBeCloseTo(0.5); expect(result.targets.eyeYaw).toBeCloseTo(0.6);
      expect(result.residualAnglesDegrees.yaw).toBeCloseTo(0);
      const corrupt = structuredClone(calibration) as any;
      corrupt.headYaw.evaluator.binding.snippet.curves['8001'] = [];
      expect(() => solveGazeBindingTargets(corrupt, { headAnglesDegrees: { yaw: 30, pitch: 0, roll: 0 },
        eyeAnglesDegrees: { yaw: 30, pitch: 0 }, headEnabled: true, eyesEnabled: true, headIntensity: 1, eyeIntensity: 1, intensity: 1 })).toThrow('source');
    } finally { f.engine.dispose(); }
  });
  it('coalesces scene observations, invalidates profile edits and releases on disposal', () => {
    const f = fixture(); let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const source = createGazeGeometryObservationSource(f.scene, () => ({ engine: f.engine, camera: f.camera }));
    const events: GazeGeometryObservation[] = []; source.subscribe(event => events.push(event));
    try {
      expect(events).toHaveLength(1); expect(events[0].available).toBe(true);
      f.camera.position.x = 1; now = 10; publishSceneObservations(f.scene); expect(events).toHaveLength(1);
      now = 40; publishSceneObservations(f.scene); expect(events).toHaveLength(2);
      now = 80; publishSceneObservations(f.scene); expect(events).toHaveLength(2);
      f.engine.bindModel(); now = 120; publishSceneObservations(f.scene);
      expect(events.at(-2)).toMatchObject({ available: false, reason: 'binding-replaced' });
      expect(events.at(-1)).toMatchObject({ available: true, generation: 2 });
      source.dispose(); expect(events.at(-1)).toMatchObject({ available: false, reason: 'disposed' });
      const count = events.length; now = 160; publishSceneObservations(f.scene); expect(events).toHaveLength(count);
    } finally { source.dispose(); f.engine.dispose(); }
  });
  it('does not republish retired facts after reentrant disposal during invalidation', () => {
    const f = fixture(); let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const source = createGazeGeometryObservationSource(f.scene, () => ({ engine: f.engine, camera: f.camera }));
    const events: GazeGeometryObservation[] = [];
    source.subscribe(event => { events.push(event); if (!event.available && event.reason === 'binding-replaced') source.dispose(); });
    try {
      f.engine.bindModel(); now = 40; publishSceneObservations(f.scene);
      expect(events.map(event => event.available)).toEqual([true, false, false]);
      expect(events.at(-1)).toMatchObject({ reason: 'disposed' });
    } finally { source.dispose(); f.engine.dispose(); }
  });
  it('isolates throwing subscribers and unregisters the last scene reader', () => {
    const f = fixture(); let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const reported = vi.fn(); vi.stubGlobal('reportError', reported);
    const source = createGazeGeometryObservationSource(f.scene, () => ({ engine: f.engine, camera: f.camera }));
    const failing = source.subscribe(() => { throw new Error('subscriber failure'); });
    const events: GazeGeometryObservation[] = [], detach = source.subscribe(event => events.push(event));
    try {
      expect(events[0].available).toBe(true); expect(reported).toHaveBeenCalled();
      failing(); detach(); const reader = vi.spyOn(f.engine, 'getGazeGeometryFacts');
      f.camera.position.x = 1; now = 40; publishSceneObservations(f.scene); expect(reader).not.toHaveBeenCalled();
    } finally { source.dispose(); f.engine.dispose(); }
  });
});
