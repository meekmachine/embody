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
