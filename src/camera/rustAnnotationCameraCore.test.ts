import { describe, expect, it } from 'vitest';
import { createRustAnnotationCameraCore } from './rustAnnotationCameraCore';

describe('RustAnnotationCameraCore marker endpoint separation', () => {
  it('separates nearby endpoints while retaining leader-line lengths', async () => {
    const core = await createRustAnnotationCameraCore();
    const starts = new Float32Array([0, 0, 1, 0.02, 0, 1]);
    const ends = new Float32Array([0, 0, 2, 0.02, 0, 2]);

    const separated = core.separateOverlappingMarkerEndpoints({
      starts,
      ends,
      modelCenter: { x: 0, y: 0, z: 0 },
      modelHeight: 1.8,
    });

    const firstLength = Math.hypot(
      separated[0] - starts[0],
      separated[1] - starts[1],
      separated[2] - starts[2],
    );
    const secondLength = Math.hypot(
      separated[3] - starts[3],
      separated[4] - starts[4],
      separated[5] - starts[5],
    );
    const endpointDistance = Math.hypot(
      separated[0] - separated[3],
      separated[1] - separated[4],
      separated[2] - separated[5],
    );

    expect(separated).toHaveLength(6);
    expect(endpointDistance).toBeGreaterThan(0.15);
    expect(firstLength).toBeCloseTo(1, 5);
    expect(secondLength).toBeCloseTo(1, 5);
  });

  it('leaves distant marker endpoints unchanged', async () => {
    const core = await createRustAnnotationCameraCore();
    const ends = new Float32Array([0, 0, 2, 2, 0, 2]);

    const separated = core.separateOverlappingMarkerEndpoints({
      starts: [0, 0, 1, 2, 0, 1],
      ends,
      modelCenter: { x: 0, y: 0, z: 0 },
      modelHeight: 1.8,
    });

    expect(Array.from(separated)).toEqual(Array.from(ends));
  });
});
