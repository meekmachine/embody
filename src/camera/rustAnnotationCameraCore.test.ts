import { describe, expect, it } from 'vitest';
import { createRustAnnotationCameraCore } from './rustAnnotationCameraCore';

describe('RustAnnotationCameraCore', () => {
  it('solves focus framing through the Wasm core', async () => {
    const core = await createRustAnnotationCameraCore();
    const framing = core.solveFocusFraming({
      focusBounds: {
        center: { x: 0, y: 0.9, z: 0 },
        size: { x: 0.8, y: 1.8, z: 0.4 },
      },
      fovDegrees: 45,
      aspect: 1,
      minDistance: 0.5,
      closeUpPaddingFactor: 1.2,
      zoomPaddingFactor: 1.5,
      fullBodyPaddingFactor: 2,
    });

    expect(framing.distance).toBeGreaterThan(0);
    expect(framing.target.y).toBeCloseTo(0.9, 5);
  });

  it('separates nearby marker endpoints while retaining line lengths', async () => {
    const core = await createRustAnnotationCameraCore();
    const starts = [0, 0, 1, 0.02, 0, 1];
    const ends = [0, 0, 2, 0.02, 0, 2];
    const separated = core.separateOverlappingMarkerEndpoints({
      starts,
      ends,
      modelCenter: { x: 0, y: 0, z: 0 },
      modelHeight: 1.8,
    });

    const firstLength = Math.hypot(separated[0] - starts[0], separated[1] - starts[1], separated[2] - starts[2]);
    const secondLength = Math.hypot(separated[3] - starts[3], separated[4] - starts[4], separated[5] - starts[5]);

    expect(separated).toHaveLength(6);
    expect(Math.hypot(separated[0] - separated[3], separated[1] - separated[4], separated[2] - separated[5]))
      .toBeGreaterThan(0.15);
    expect(firstLength).toBeCloseTo(1, 5);
    expect(secondLength).toBeCloseTo(1, 5);
  });
});
