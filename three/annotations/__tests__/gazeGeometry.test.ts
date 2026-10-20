import { describe, expect, it } from 'vitest';
import { solveGazeGeometry, type GazeGeometryInput } from '@lovelace_lol/embody/wasm';

const facts = (): GazeGeometryInput => ({
  cameraPosition: [0, 0, 5], cameraQuaternion: [0, 0, 0, 1],
  characterWorldQuaternion: [0, 0, 0, 1], eyeOriginWorld: [0, 0, 0],
  verticalFovDegrees: 90, aspect: 1, target: { kind: 'screen', x: 0, y: 0 },
});
describe('public gaze geometry', () => {
  it('returns neutral viewer bearing through the initialized Wasm wrapper', () => {
    const result = solveGazeGeometry(facts());
    expect(result.targetAnglesDegrees).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    expect(result.characterFacingCamera).toBe(true);
  });
  it('includes character world orientation and authored roll', () => {
    const result = solveGazeGeometry({ ...facts(),
      characterWorldQuaternion: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)],
      targetRollDegrees: 8,
    });
    expect(result.targetAnglesDegrees.yaw).toBeCloseTo(90);
    expect(result.cameraAnglesDegrees.yaw).toBeCloseTo(90);
    expect(result.targetAnglesDegrees.roll).toBe(8);
  });
  it('rejects out-of-range screen input at the Rust boundary', () => {
    expect(() => solveGazeGeometry({ ...facts(), target: { kind: 'screen', x: 2, y: 0 } })).toThrow();
  });
});

import { Bone, Group, PerspectiveCamera } from 'three';
import { Embody } from '../../character';

describe('character gaze observation', () => {
  it('uses mapped eye midpoint and model root orientation, preserving camera zoom', () => {
    const model = new Group(); model.rotation.y = Math.PI / 4;
    const left = new Bone(); left.name = 'CustomLeft'; left.position.set(-1, 2, 0);
    const right = new Bone(); right.name = 'CustomRight'; right.position.set(1, 2, 0);
    model.add(left, right);
    const engine = new Embody({ profileMode: 'profile', profile: {
      boneNodes: { opticalLeft: 'CustomLeft', opticalRight: 'CustomRight' },
      humanoidCharacterization: { schemaVersion: 1, standard: 'VRMC_vrm-1.0', roles: {
        leftEye: { nodeKey: 'opticalLeft' }, rightEye: { nodeKey: 'opticalRight' },
      } },
    } });
    engine.onReady({ model });
    const camera = new PerspectiveCamera(90, 2); camera.position.z = 5; camera.zoom = 2;
    const facts = engine.getGazeGeometryFacts(camera);
    expect(facts.eyeOriginWorld).toEqual([0, 2, 0]);
    expect(facts.characterWorldQuaternion[1]).toBeCloseTo(Math.sin(Math.PI / 8));
    expect(facts.verticalFovDegrees).toBeCloseTo(camera.getEffectiveFOV());
    expect(engine.getGazeControlCapabilities()['body.eyeRoll']).toEqual({ positive: false, negative: false });
    engine.dispose();
  });
  it('reports unavailable origin instead of silently using the model center', () => {
    const engine = new Embody({ profileMode: 'profile', profile: {} });
    engine.onReady({ model: new Group() });
    expect(() => engine.getGazeGeometryFacts(new PerspectiveCamera())).toThrow('mapped eye or head');
    engine.dispose();
  });
});
