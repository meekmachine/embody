import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAnnotationCameraCore, requireAnnotationCameraCore } from '../annotationCameraCore';

import {
  DPthree3DMarkers,
  resolveViewportConstrainedLineScale,
  resolveViewportSafeBounds,
  shouldShow3DMarker,
} from '../DPthree3DMarkers';

beforeAll(async () => {
  await getAnnotationCameraCore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shouldShow3DMarker', () => {
  it('keeps collapsed child markers hidden even if their camera angle matches', () => {
    expect(
      shouldShow3DMarker({
        name: 'left_eye',
        hiddenChildren: new Set(['left_eye']),
        soloedMarker: null,
        markerAngle: 45,
        currentCameraAngle: 45,
      })
    ).toBe(false);
  });

  it('hides non-solo markers while solo mode is active', () => {
    expect(
      shouldShow3DMarker({
        name: 'right_eye',
        hiddenChildren: new Set(),
        soloedMarker: 'head',
        markerAngle: 315,
        currentCameraAngle: 315,
      })
    ).toBe(false);
  });

  it('shows visible children when expanded and within camera angle gate', () => {
    expect(
      shouldShow3DMarker({
        name: 'right_eye',
        hiddenChildren: new Set(),
        soloedMarker: null,
        markerAngle: 315,
        currentCameraAngle: 315,
      })
    ).toBe(true);
  });
});

describe('resolveViewportConstrainedLineScale', () => {
  it('keeps full line length when the endpoint already fits the safe viewport', () => {
    expect(
      resolveViewportConstrainedLineScale({
        startClip: new THREE.Vector4(0, 0, 0, 1),
        endClip: new THREE.Vector4(0.4, 0.2, 0, 1),
        safeX: 0.85,
        safeY: 0.85,
      })
    ).toEqual({ visible: true, lineScale: 1 });
  });

  it('shortens the line to the safe horizontal bound when the label would run off frame', () => {
    const result = resolveViewportConstrainedLineScale({
      startClip: new THREE.Vector4(0, 0, 0, 1),
      endClip: new THREE.Vector4(2, 0, 0, 1),
      safeX: 0.8,
      safeY: 0.9,
    });

    expect(result.visible).toBe(true);
    expect(result.lineScale).toBeCloseTo(0.4, 6);
  });

  it('hides the marker when even the start of the line sits outside the safe viewport direction', () => {
    expect(
      resolveViewportConstrainedLineScale({
        startClip: new THREE.Vector4(0.95, 0, 0, 1),
        endClip: new THREE.Vector4(1.2, 0, 0, 1),
        safeX: 0.8,
        safeY: 0.9,
      })
    ).toEqual({ visible: false, lineScale: 0 });
  });

  it('hides the marker when the anchor point itself is already offscreen', () => {
    expect(
      resolveViewportConstrainedLineScale({
        startClip: new THREE.Vector4(1.2, 0, 0, 1),
        endClip: new THREE.Vector4(1.4, 0, 0, 1),
        safeX: 0.8,
        safeY: 0.9,
      })
    ).toEqual({ visible: false, lineScale: 0 });
  });
});

describe('resolveViewportSafeBounds', () => {
  it('keeps a fixed pixel gutter around screen-space annotation labels', () => {
    const bounds = resolveViewportSafeBounds({
      labelScaleX: 0.1,
      labelScaleY: 0.04,
      projectionXScale: 2,
      projectionYScale: 2.5,
      viewportWidth: 1000,
      viewportHeight: 750,
      edgePaddingPx: 12,
    });

    expect(bounds.safeX).toBeCloseTo(0.876, 6);
    expect(bounds.safeY).toBeCloseTo(0.918, 6);
  });

  it('uses the viewport width and height independently for edge padding', () => {
    const wide = resolveViewportSafeBounds({
      labelScaleX: 0,
      labelScaleY: 0,
      projectionXScale: 1,
      projectionYScale: 1,
      viewportWidth: 1200,
      viewportHeight: 600,
      edgePaddingPx: 12,
    });

    expect(wide.safeX).toBeCloseTo(0.98, 6);
    expect(wide.safeY).toBeCloseTo(0.96, 6);
  });
});

describe('marker endpoint separation', () => {
  it('delegates endpoint planning to Polymer and applies the returned directions', () => {
    const lineEndpoints = new Map([
      [
        'left_eye',
        {
          start: new THREE.Vector3(0, 0, 1),
          end: new THREE.Vector3(0, 0, 2),
          direction: new THREE.Vector3(0, 0, 1),
        },
      ],
      [
        'right_eye',
        {
          start: new THREE.Vector3(0.02, 0, 1),
          end: new THREE.Vector3(0.02, 0, 2),
          direction: new THREE.Vector3(0, 0, 1),
        },
      ],
    ]);
    const separateOverlappingMarkerEndpoints = vi.fn(
      () => new Float32Array([-0.1, 0, 1.99, 0.12, 0, 1.99])
    );
    const updateMarkerGeometry = vi.fn();
    const markers = {
      lineEndpoints,
      modelCenter: new THREE.Vector3(),
      modelSize: new THREE.Vector3(1, 1.8, 1),
      updateMarkerGeometry,
    };

    (DPthree3DMarkers.prototype as any).separateOverlappingMarkers.call(markers, {
      separateOverlappingMarkerEndpoints,
    });

    expect(separateOverlappingMarkerEndpoints).toHaveBeenCalledWith({
      starts: new Float32Array([0, 0, 1, 0.02, 0, 1]),
      ends: new Float32Array([0, 0, 2, 0.02, 0, 2]),
      modelCenter: markers.modelCenter,
      modelHeight: 1.8,
    });
    expect(lineEndpoints.get('left_eye')?.direction.x).toBeLessThan(0);
    expect(lineEndpoints.get('right_eye')?.direction.x).toBeGreaterThan(0);
    expect(updateMarkerGeometry).toHaveBeenCalledTimes(2);
    expect(updateMarkerGeometry.mock.calls[0][2].x).toBeCloseTo(-0.1);
    expect(updateMarkerGeometry.mock.calls[1][2].x).toBeCloseTo(0.12);
  });
});

describe('incremental marker loading', () => {
  it('yields to a render frame between expensive region builds', async () => {
    const pendingFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    }));

    const markers = new DPthree3DMarkers({
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      domElement: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLElement,
      onSelect: vi.fn(),
    });
    const createMarker = vi
      .spyOn(markers as any, 'createMarker')
      .mockImplementation(() => undefined);
    const separateMarkers = vi
      .spyOn(markers as any, 'separateOverlappingMarkers')
      .mockImplementation(() => undefined);

    const loading = markers.loadRegions({
      characterId: 'test-character',
      characterName: 'Test Character',
      modelPath: 'test.glb',
      regions: [
        { name: 'head' },
        { name: 'left_eye' },
        { name: 'right_eye' },
      ],
    });

    await vi.waitFor(() => expect(createMarker).toHaveBeenCalledTimes(1));
    expect(pendingFrames).toHaveLength(1);

    pendingFrames.shift()?.(16);
    await vi.waitFor(() => expect(createMarker).toHaveBeenCalledTimes(2));
    expect(pendingFrames).toHaveLength(1);

    pendingFrames.shift()?.(32);
    await loading;

    expect(createMarker).toHaveBeenCalledTimes(3);
    expect(separateMarkers).toHaveBeenCalledOnce();
    markers.dispose();
  });
});

describe('Rust marker visibility and clipping', () => {
  it.each([
    [315, 45, true],
    [315, 46, false],
    [0, 180, true],
    [undefined, 180, true],
  ])('retains angle wrapping and the 90 degree gate (%s, %s)', (markerAngle, currentCameraAngle, visible) => {
    expect(shouldShow3DMarker({
      name: 'head',
      hiddenChildren: new Set(),
      soloedMarker: null,
      markerAngle,
      currentCameraAngle,
    })).toBe(visible);
  });

  it.each([NaN, Infinity, -Infinity])('hides a line with a nonfinite projected endpoint (%s)', (coordinate) => {
    expect(resolveViewportConstrainedLineScale({
      startClip: new THREE.Vector4(0, 0, 0, 1),
      endClip: new THREE.Vector4(coordinate, 0, 0, 1),
      safeX: 0.8,
      safeY: 0.8,
    })).toEqual({ visible: false, lineScale: 0 });
  });

  it.each([
    [new THREE.Vector4(0, 0, 0, -1), new THREE.Vector4(1, 0, 0, 1)],
    [new THREE.Vector4(0, 0, -2, 1), new THREE.Vector4(1, 0, 0, 1)],
    [new THREE.Vector4(0, 0, 0, 1), new THREE.Vector4(10, 0, 0, 1)],
  ])('hides behind-camera, near-clipped, or unusably short leader lines', (startClip, endClip) => {
    expect(resolveViewportConstrainedLineScale({ startClip, endClip, safeX: 0.8, safeY: 0.8 }))
      .toEqual({ visible: false, lineScale: 0 });
  });

  it('reuses clip input arrays while applying Rust layout to rendered marker endpoints', () => {
    const camera = new THREE.PerspectiveCamera(90, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);
    const markers = new DPthree3DMarkers({
      scene: new THREE.Scene(), camera,
      domElement: {
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        getBoundingClientRect: () => ({ width: 1000, height: 1000 }),
      } as unknown as HTMLElement,
      onSelect: vi.fn(),
    });
    const internals = markers as any;
    const sphere = new THREE.Mesh();
    const label = new THREE.Sprite();
    label.scale.set(0.1, 0.1, 1);
    internals.markerMeshes.set('head', sphere);
    internals.labelSprites.set('head', label);
    internals.lineEndpoints.set('head', {
      start: new THREE.Vector3(), end: new THREE.Vector3(10, 0, 0), direction: new THREE.Vector3(1, 0, 0),
    });
    internals.originalLineLengths.set('head', 10);
    const updateMarkerGeometry = vi.spyOn(internals, 'updateMarkerGeometry').mockImplementation(() => undefined);
    const resolveLine = vi.spyOn(requireAnnotationCameraCore(), 'resolveViewportConstrainedLineScale');

    expect(internals.updateMarkerLineLayout('head')).toBe(true);
    expect(updateMarkerGeometry).toHaveBeenCalledWith('head', sphere.position, expect.objectContaining({ x: expect.closeTo(4.63, 5), y: 0, z: 0 }));
    const firstInputs = resolveLine.mock.calls[0][0] as { startClip: number[]; endClip: number[] };
    internals.updateMarkerLineLayout('head');
    const secondInputs = resolveLine.mock.calls[1][0] as typeof firstInputs;
    expect(secondInputs.startClip).toBe(firstInputs.startClip);
    expect(secondInputs.endClip).toBe(firstInputs.endClip);

    internals.lineEndpoints.get('head').direction.x = NaN;
    expect(internals.updateMarkerLineLayout('head')).toBe(false);
    expect(internals.markerViewportVisibility.get('head')).toBe(false);
    expect(resolveLine).toHaveBeenCalledTimes(2);
    markers.dispose();
  });
});

describe('Rust leader-line curves', () => {
  const markers = DPthree3DMarkers.prototype as any;

  it('retains the quadratic bezier midpoint and both endpoints', () => {
    const points = markers.createBezierCurve(new THREE.Vector3(), new THREE.Vector3(2, 0, 0), 2);
    expect(points).toHaveLength(3);
    expect(points[0].toArray()).toEqual([0, 0, 0]);
    expect(points[1].x).toBeCloseTo(1, 6);
    expect(points[1].y).toBeCloseTo(0.3, 6);
    expect(points[2].toArray()).toEqual([2, 0, 0]);
  });

  it('uses the canonical Rust arc with a normalized perpendicular and linear scale', () => {
    // The removed JS arc reused a perpendicular mutated by unused arc-center
    // math, reversing the bend and making its depth grow quadratically.
    const small = markers.createArcCurve(new THREE.Vector3(), new THREE.Vector3(2, 0, 0), 2);
    const large = markers.createArcCurve(new THREE.Vector3(), new THREE.Vector3(4, 0, 0), 2);
    expect(small[1].x).toBeCloseTo(1, 6);
    expect(small[1].z).toBeCloseTo(0.36, 6);
    expect(large[1].z).toBeCloseTo(small[1].z * 2, 6);
    expect(small[0].distanceTo(new THREE.Vector3())).toBeLessThan(1e-6);
    expect(small[2].distanceTo(new THREE.Vector3(2, 0, 0))).toBeLessThan(1e-6);
  });

  it.each(['createBezierCurve', 'createArcCurve'])('%s stays finite for coincident and nearly axial endpoints', (method) => {
    for (const end of [new THREE.Vector3(), new THREE.Vector3(0.00001, 2, 0.00001), new THREE.Vector3(0.00001, 0.00001, 2)]) {
      const points: THREE.Vector3[] = markers[method](new THREE.Vector3(), end);
      expect(points).toHaveLength(17);
      expect(points.every(point => point.toArray().every(Number.isFinite))).toBe(true);
      expect(points[0].length()).toBeLessThan(1e-6);
      expect(points[points.length - 1].distanceTo(end)).toBeLessThan(1e-6);
    }
  });
});

describe('Rust marker visibility animation', () => {
  it('applies the existing show overshoot and hide completion factors to Three objects', () => {
    const markers = DPthree3DMarkers.prototype as any;
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial({ opacity: 0.8 }));
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ opacity: 0.9 }));
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ opacity: 0.7 }));
    const scale = new THREE.Vector3(0.1, 0.05, 1);
    const states = [{ sphere: { object: sphere, opacity: 0.8 }, line: { object: line, opacity: 0.9 }, label: { object: label, opacity: 0.7, scale } }];

    markers.applyVisibilityAnimationStates(states, true, 0);
    expect(sphere.material.opacity).toBe(0);
    expect(line.material.opacity).toBe(0);
    expect(label.scale.x).toBeCloseTo(0.018, 6);
    markers.applyVisibilityAnimationStates(states, true, 0.68);
    expect(label.scale.x).toBeCloseTo(0.128, 6);
    markers.applyVisibilityAnimationStates(states, true, 1);
    expect(sphere.material.opacity).toBeCloseTo(0.8, 6);
    expect(line.material.opacity).toBeCloseTo(0.9, 6);
    expect(label.scale.x).toBeCloseTo(0.1, 6);
    markers.applyVisibilityAnimationStates(states, false, 1);
    expect(sphere.material.opacity).toBe(0);
    expect(line.material.opacity).toBe(0);
    expect(label.scale.x).toBeCloseTo(0.014, 6);
    sphere.geometry.dispose();
    sphere.material.dispose();
    line.geometry.dispose();
    line.material.dispose();
    label.material.dispose();
  });
});
