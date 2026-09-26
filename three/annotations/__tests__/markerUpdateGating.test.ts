import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getAnnotationCameraCore } from '../annotationCameraCore';
import { DPthree3DMarkers } from '../DPthree3DMarkers';
import { DPthreeHTMLMarkers } from '../DPthreeHTMLMarkers';

beforeAll(async () => {
  await getAnnotationCameraCore();
});

describe('marker update gating', () => {
  it('skips 3D marker work while markers are fully hidden', () => {
    const updatePositionsSpy = vi.fn();
    const markers = {
      model: {},
      markerGroup: { visible: false },
      visibilityAnimationActive: false,
      updateMarkerPositions: updatePositionsSpy,
    };

    DPthree3DMarkers.prototype.update.call(markers as any);

    expect(updatePositionsSpy).not.toHaveBeenCalled();
  });

  it('runs camera-angle marker layout on the first visible update', () => {
    const updateMarkerLineLayout = vi.fn(() => true);
    const setMarkerObjectsVisible = vi.fn();
    const model = new THREE.Group();
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld(true);

    const markers = {
      model,
      markerGroup: { visible: true },
      visibilityAnimationFrame: null,
      updateMarkerPositions: vi.fn(),
      camera,
      modelCenter: new THREE.Vector3(),
      lastCameraDistance: 5,
      zoomThreshold: 2,
      lastCameraAngleUpdatePosition: new THREE.Vector3(),
      lastCameraAngleUpdateQuaternion: new THREE.Quaternion(),
      hasCameraAngleUpdateSnapshot: false,
      markerMeshes: new Map([
        ['left_eye', { userData: { cameraAngle: 90 }, position: new THREE.Vector3() }],
      ]),
      hiddenChildren: new Set(),
      soloedMarker: null,
      markerViewportVisibility: new Map(),
      markerAngleGateVisibility: new Map(),
      activeMarkerVisibilityAnimations: new Set(),
      updateMarkerLineLayout,
      setMarkerObjectsVisible,
    };

    DPthree3DMarkers.prototype.update.call(markers as any);

    expect(updateMarkerLineLayout).toHaveBeenCalledWith('left_eye');
    expect(setMarkerObjectsVisible).toHaveBeenCalledWith('left_eye', true);
    expect(markers.hasCameraAngleUpdateSnapshot).toBe(true);
  });

  it('skips HTML marker work while markers are fully hidden', () => {
    const markers = {
      model: {},
      occlusionGroup: { visible: false },
      frameId: 0,
    };

    DPthreeHTMLMarkers.prototype.update.call(markers as any);

    expect(markers.frameId).toBe(0);
  });
});
