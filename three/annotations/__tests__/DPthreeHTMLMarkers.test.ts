import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { DPthreeHTMLMarkers } from '../DPthreeHTMLMarkers';
import type { AnnotationAnchoredRegion } from '../types';

function createFaceMesh(name: string, position: THREE.Vector3): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.16, 0.08),
    new THREE.MeshBasicMaterial()
  );

  mesh.name = name;
  mesh.position.copy(position);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function createMarkerResolver(model: THREE.Object3D): any {
  const markers = Object.create(DPthreeHTMLMarkers.prototype);

  markers.model = model;
  markers.characterConfig = null;
  markers.faceCenterCache = new Map();

  return markers;
}

describe('DPthreeHTMLMarkers camera visibility', () => {
  it.each([
    [undefined, false, true],
    [0, false, true],
    [90, false, true],
    [180, false, false],
    [270, false, true],
    [315, false, true],
    [0, true, false],
  ])('gates angle %s and collapsed child %s through the shared angle policy', (angle, hidden, visible) => {
    const markers = Object.create(DPthreeHTMLMarkers.prototype);
    const marker = {};
    markers.markers = new Map([['eye', marker]]);
    markers.hiddenChildren = new Set(hidden ? ['eye'] : []);
    markers.model = new THREE.Group();
    markers.modelCenter = new THREE.Vector3();
    markers.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    markers.camera.position.set(0, 0, 5);
    markers.camera.lookAt(0, 0, 0);
    markers.camera.updateMatrixWorld(true);
    markers.frameId = 1;
    markers.markerFrameIds = new Map();
    markers.getViewportSize = () => ({ width: 800, height: 600 });
    markers.setMarkerDisplay = vi.fn();
    markers.setMarkerScreenPosition = vi.fn();
    const mesh = new THREE.Mesh();
    mesh.userData = { cameraAngle: angle, position: new THREE.Vector3() };

    markers.onProxyRendered('eye', mesh);

    expect(markers.setMarkerDisplay).toHaveBeenCalledWith(marker, visible);
    expect(markers.setMarkerScreenPosition).toHaveBeenCalledTimes(visible ? 1 : 0);
  });
});

describe('DPthreeHTMLMarkers face-center anchors', () => {
  it('caches explicit face-center anchors per region', () => {
    const model = new THREE.Group();
    const faceMesh = createFaceMesh('PrimarySurface', new THREE.Vector3(0, 1.4, 0.24));
    const sideFaceMesh = createFaceMesh('SecondarySurface', new THREE.Vector3(0.4, 0.8, -0.12));
    model.add(faceMesh);
    model.add(sideFaceMesh);
    model.updateMatrixWorld(true);

    const markers = createMarkerResolver(model);
    const primaryFace: AnnotationAnchoredRegion = {
      name: 'expression_driver',
      markerAnchor: {
        type: 'face-center',
        meshes: ['PrimarySurface'],
      },
    };
    const sideFace: AnnotationAnchoredRegion = {
      name: 'side_expression_driver',
      markerAnchor: {
        type: 'face-center',
        meshes: ['SecondarySurface'],
      },
    };

    const getRegionCenter = markers.getRegionCenter.bind(markers) as (
      region: AnnotationAnchoredRegion
    ) => THREE.Vector3 | null;

    const primaryCenter = getRegionCenter(primaryFace);
    const sideCenter = getRegionCenter(sideFace);
    const primaryCenterAgain = getRegionCenter(primaryFace);

    expect(primaryCenter).not.toBeNull();
    expect(sideCenter).not.toBeNull();
    expect(primaryCenterAgain).not.toBeNull();
    expect(primaryCenter!.x).toBeCloseTo(0, 5);
    expect(primaryCenter!.y).toBeCloseTo(1.4, 5);
    expect(primaryCenter!.z).toBeCloseTo(0.24, 5);
    expect(sideCenter!.x).toBeCloseTo(0.4, 5);
    expect(sideCenter!.y).toBeCloseTo(0.8, 5);
    expect(sideCenter!.z).toBeCloseTo(-0.12, 5);
    expect(primaryCenterAgain!.distanceTo(primaryCenter!)).toBeLessThan(1e-6);
    expect(markers.faceCenterCache.size).toBe(2);

    faceMesh.geometry.dispose();
    sideFaceMesh.geometry.dispose();
  });
});
