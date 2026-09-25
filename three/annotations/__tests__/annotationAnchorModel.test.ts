import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { AnnotationAnchoredRegion } from '../types';
import {
  resolveMarkerAnchorRegion,
  shouldProjectMarkerAnchorToSurface,
  shouldUseFaceCenterForMarkerAnchor,
} from '../annotationAnchorModel';
import {
  getRuntimeAUMorphAnchorPoint,
  getRuntimeAnnotationSide,
  getRuntimeAUMeshSideOffset,
} from '../runtimeAnnotationSidePreview';

describe('annotation anchor model', () => {
  it('keeps legacy regions on their existing implicit semantics', () => {
    const region: AnnotationAnchoredRegion = {
      name: 'face',
      bones: ['HEAD'],
    };

    const resolved = resolveMarkerAnchorRegion(region);

    expect(resolved.source).toBe('legacy-region');
    expect(resolved.region).toBe(region);
    expect(resolved.useLegacyRegionSemantics).toBe(true);
    expect(shouldUseFaceCenterForMarkerAnchor(resolved)).toBe(true);
    expect(shouldProjectMarkerAnchorToSurface(resolved, true)).toBe(true);
  });

  it('maps point anchors to customPosition and disables surface projection by default', () => {
    const region: AnnotationAnchoredRegion = {
      name: 'left_eye',
      bones: ['HEAD'],
      markerAnchor: {
        type: 'point',
        position: { x: 1, y: 2, z: 3 },
      },
    };

    const resolved = resolveMarkerAnchorRegion(region);

    expect(resolved.source).toBe('marker-anchor');
    expect(resolved.region).toMatchObject({
      name: 'left_eye',
      customPosition: { x: 1, y: 2, z: 3 },
    });
    expect(resolved.region.bones).toBeUndefined();
    expect(shouldUseFaceCenterForMarkerAnchor(resolved)).toBe(false);
    expect(shouldProjectMarkerAnchorToSurface(resolved, true)).toBe(false);
  });

  it('lets bone anchors override region mesh targets and project to the surface', () => {
    const region: AnnotationAnchoredRegion = {
      name: 'mouth',
      meshes: ['FaceMesh'],
      markerAnchor: {
        type: 'bone',
        bones: ['JAW'],
      },
    };

    const resolved = resolveMarkerAnchorRegion(region);

    expect(resolved.region.bones).toEqual(['JAW']);
    expect(resolved.region.meshes).toBeUndefined();
    expect(shouldUseFaceCenterForMarkerAnchor(resolved)).toBe(false);
    expect(shouldProjectMarkerAnchorToSurface(resolved, false)).toBe(true);
  });

  it('lets mesh anchors skip surface projection unless requested', () => {
    const region: AnnotationAnchoredRegion = {
      name: 'hair',
      bones: ['HEAD'],
      markerAnchor: {
        type: 'mesh',
        meshes: ['HairMesh'],
      },
    };

    const resolved = resolveMarkerAnchorRegion(region);

    expect(resolved.region.meshes).toEqual(['HairMesh']);
    expect(resolved.region.bones).toBeUndefined();
    expect(shouldProjectMarkerAnchorToSurface(resolved, true)).toBe(false);
  });

  it('uses explicit face-center anchors even when the region name is not face-like', () => {
    const region: AnnotationAnchoredRegion = {
      name: 'expression_driver',
      markerAnchor: {
        type: 'face-center',
        bones: ['HEAD'],
        meshes: ['FaceMesh'],
      },
    };

    const resolved = resolveMarkerAnchorRegion(region);

    expect(resolved.region.bones).toEqual(['HEAD']);
    expect(resolved.region.meshes).toEqual(['FaceMesh']);
    expect(shouldUseFaceCenterForMarkerAnchor(resolved)).toBe(true);
    expect(shouldProjectMarkerAnchorToSurface(resolved, false)).toBe(true);
  });

  it('offsets side-specific runtime AU mesh previews away from the mesh center', () => {
    const region: AnnotationAnchoredRegion = {
      name: 'runtime:annotation:au:1:left:mesh:FaceMesh',
      label: 'AU 1: Inner Brow Raiser',
      meshes: ['FaceMesh'],
      runtimeAnnotation: {
        targetType: 'au',
        target: '1',
        meshName: 'FaceMesh',
        morphNames: ['Brow_Raise_Inner_L'],
        side: 'left',
      },
    };

    const offset = getRuntimeAUMeshSideOffset(region, -1, new THREE.Vector3(1, 2, 0.5));

    expect(getRuntimeAnnotationSide(region)).toBe('left');
    expect(offset?.x).toBeLessThan(0);
    expect(offset?.y).toBeGreaterThan(0);
    expect(offset?.z).toBeGreaterThan(0);
  });

  it('anchors runtime AU brow morph previews to affected upper vertices', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, 1.4, 0,
      -1, 1.2, 0,
      -1, 0, 0,
      -1, -0.2, 0,
    ], 3));
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [
      new THREE.Float32BufferAttribute([
        0, 0.3, 0.1,
        0, 0.25, 0.1,
        0, 1, 0,
        0, 1, 0,
      ], 3),
    ];

    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.name = 'FaceMesh';
    mesh.morphTargetDictionary = { Brow_Raise_Inner_L: 0 };
    mesh.morphTargetInfluences = [0];
    mesh.position.set(0.25, 0, 0.5);
    mesh.updateMatrixWorld(true);

    const region: AnnotationAnchoredRegion = {
      name: 'runtime:annotation:au:1:left:mesh:FaceMesh',
      label: 'AU 1: Inner Brow Raiser',
      meshes: ['FaceMesh'],
      runtimeAnnotation: {
        targetType: 'au',
        target: '1',
        meshName: 'FaceMesh',
        morphNames: ['Brow_Raise_Inner_L'],
        side: 'left',
      },
    };

    const anchor = getRuntimeAUMorphAnchorPoint(region, mesh);

    expect(anchor).not.toBeNull();
    expect(anchor!.x).toBeCloseTo(-0.75, 5);
    expect(anchor!.y).toBeGreaterThan(1.2);
    expect(anchor!.z).toBeCloseTo(0.5, 5);

    geometry.dispose();
  });

  it('anchors runtime AU mouth morph previews to lower affected vertices', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, 1.2, 0,
      -1, 1, 0,
      -1, 0.2, 0,
      -1, 0, 0,
    ], 3));
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [
      new THREE.Float32BufferAttribute([
        0, 0.5, 0,
        0, 0.5, 0,
        0, 0.8, 0.1,
        0, 0.9, 0.1,
      ], 3),
    ];

    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.name = 'FaceMesh';
    mesh.morphTargetDictionary = { Mouth_Smile_L: 0 };
    mesh.morphTargetInfluences = [0];
    mesh.updateMatrixWorld(true);

    const region: AnnotationAnchoredRegion = {
      name: 'runtime:annotation:au:12:left:mesh:FaceMesh',
      label: 'AU 12: Lip Corner Puller',
      meshes: ['FaceMesh'],
      runtimeAnnotation: {
        targetType: 'au',
        target: '12',
        meshName: 'FaceMesh',
        morphNames: ['Mouth_Smile_L'],
        side: 'left',
      },
    };

    const anchor = getRuntimeAUMorphAnchorPoint(region, mesh);

    expect(anchor).not.toBeNull();
    expect(anchor!.y).toBeLessThan(0.25);

    geometry.dispose();
  });
});
