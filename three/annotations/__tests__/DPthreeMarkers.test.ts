import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DPthreeMarkers } from '../DPthreeMarkers';

describe('legacy marker camera visibility', () => {
  it.each([
    [-45, 315, 1, true],
    [0, 180, 1, false],
    [0, 90, 1, true],
    [0, undefined, -1, false],
    [0, 0, 1, true],
  ])('preserves angle wrapping and front-surface occlusion (%s, %s, %s)', (cameraAngle, markerAngle, depth, visible) => {
    const markers = Object.create(DPthreeMarkers.prototype);
    const label = { style: {} as CSSStyleDeclaration, __position: new THREE.Vector3(0, 0, Number(depth)) };
    markers.labels = new Map([['control', label]]);
    markers.regions = [{ name: 'control', cameraAngle: markerAngle }];
    markers.model = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    markers.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    const angle = THREE.MathUtils.degToRad(Number(cameraAngle));
    markers.camera.position.set(5 * Math.sin(angle), 0, 5 * Math.cos(angle));
    markers.camera.lookAt(0, 0, 0);
    markers.camera.updateMatrixWorld(true);
    markers.getRegionCenter = () => label.__position.clone();
    markers.domElement = { getBoundingClientRect: () => ({ width: 800, height: 600 }) };

    markers.update();

    expect(label.style.display).toBe(visible ? 'flex' : 'none');
    markers.model.geometry.dispose();
    markers.model.material.dispose();
  });
});
