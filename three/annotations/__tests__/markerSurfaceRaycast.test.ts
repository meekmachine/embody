import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { intersectMeshesInSlices } from '../markerSurfaceRaycast';

function plane(z: number, side: THREE.Side = THREE.DoubleSide) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ side }));
  mesh.position.z = z;
  mesh.updateMatrixWorld(true);
  return mesh;
}

function hitData(hits: THREE.Intersection[] | null) {
  return hits?.map((hit) => ({
    object: hit.object.uuid, distance: hit.distance, point: hit.point.toArray(),
    faceIndex: hit.faceIndex, face: hit.face, uv: hit.uv?.toArray(), normal: hit.normal?.toArray(),
  }));
}

describe('native marker surface raycasts in slices', () => {
  it('preserves every sorted hit, material sides, layers, invisible surfaces and nonrecursive traversal', async () => {
    const far = plane(-1);
    const near = plane(1, THREE.FrontSide);
    const tied = plane(1);
    const backOnly = plane(2, THREE.BackSide);
    const hidden = plane(0.5); hidden.visible = false;
    const otherLayer = plane(2.5); otherLayer.layers.set(1);
    const child = plane(2); far.add(child); far.updateMatrixWorld(true);
    const meshes = [far, near, tied, backOnly, hidden, otherLayer];
    const ray = new THREE.Raycaster(new THREE.Vector3(0.2, 0.1, 4), new THREE.Vector3(0, 0, -1));
    const native = ray.intersectObjects(meshes, false);
    const yieldToPaint = vi.fn(async () => undefined);
    let clock = 0;
    const sliced = await intersectMeshesInSlices(ray, meshes, {
      isCurrent: () => true, yieldToPaint, now: () => (clock += 4),
    });
    expect(hitData(sliced)).toEqual(hitData(native));
    expect(sliced?.map((hit) => hit.object)).toEqual([near, tied, hidden, far]);
    expect(yieldToPaint).toHaveBeenCalledTimes(meshes.length - 1);
  });

  it('preserves draw ranges and grouped material arrays without changing geometry', async () => {
    const geometry = new THREE.BoxGeometry(2, 2, 2);
    geometry.setDrawRange(12, 18);
    const materials = Array.from({ length: 6 }, (_, index) => new THREE.MeshBasicMaterial({
      side: index % 2 ? THREE.BackSide : THREE.DoubleSide,
    }));
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.updateMatrixWorld(true);
    const before = {
      positions: Array.from(geometry.attributes.position.array),
      indices: Array.from(geometry.index!.array),
      groups: structuredClone(geometry.groups), drawRange: { ...geometry.drawRange },
      sides: materials.map((material) => material.side),
    };
    const ray = new THREE.Raycaster(new THREE.Vector3(0.2, 0.1, 4), new THREE.Vector3(0, 0, -1));
    const native = ray.intersectObjects([mesh], false);
    const sliced = await intersectMeshesInSlices(ray, [mesh], { isCurrent: () => true, yieldToPaint: async () => undefined });
    expect(hitData(sliced)).toEqual(hitData(native));
    expect(sliced?.length).toBeGreaterThan(0);
    expect({
      positions: Array.from(geometry.attributes.position.array), indices: Array.from(geometry.index!.array),
      groups: geometry.groups, drawRange: geometry.drawRange, sides: materials.map((material) => material.side),
    }).toEqual(before);
  });

  it('uses native skinned and morphed vertex positions', async () => {
    const geometry = new THREE.PlaneGeometry(2, 2);
    const count = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(count * 4).fill(0), 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0), 4));
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(
      Array.from({ length: count * 3 }, (_, i) => i % 3 === 2 ? 0.3 : 0), 3,
    )];
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const bone = new THREE.Bone(); mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
    mesh.morphTargetInfluences![0] = 1;
    bone.position.z = 0.4;
    mesh.updateMatrixWorld(true); mesh.skeleton.update();
    const ray = new THREE.Raycaster(new THREE.Vector3(0.2, 0.1, 4), new THREE.Vector3(0, 0, -1));
    const native = ray.intersectObjects([mesh], false);
    const sliced = await intersectMeshesInSlices(ray, [mesh], { isCurrent: () => true, yieldToPaint: async () => undefined });
    expect(hitData(sliced)).toEqual(hitData(native));
    expect(sliced?.[0].point.z).toBeCloseTo(0.7);
    expect(mesh.morphTargetInfluences).toEqual([1]);
    expect(bone.position.z).toBe(0.4);
  });

  it('yields after the elapsed budget and never splits an individual native mesh call', async () => {
    let clock = 0;
    const completed: number[] = [];
    const meshes = [2, 3, 8, 1].map((cost, index) => {
      const mesh = plane(index);
      const native = mesh.raycast.bind(mesh);
      vi.spyOn(mesh, 'raycast').mockImplementation((raycaster, hits) => {
        native(raycaster, hits); clock += cost; completed.push(index);
      });
      return mesh;
    });
    const boundaries: number[][] = [];
    const result = await intersectMeshesInSlices(new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1)), meshes, {
      isCurrent: () => true, now: () => clock,
      yieldToPaint: async () => { boundaries.push([...completed]); },
    });
    expect(result?.length).toBeGreaterThan(0);
    expect(boundaries).toEqual([[0, 1], [0, 1, 2]]);
    expect(completed).toEqual([0, 1, 2, 3]);
  });

  it('stops before another mesh and discards accumulated hits when canceled during a yield', async () => {
    const first = plane(1); const second = plane(0);
    const secondRaycast = vi.spyOn(second, 'raycast');
    let current = true;
    let clock = 0;
    const hits = await intersectMeshesInSlices(new THREE.Raycaster(new THREE.Vector3(0, 0, 4), new THREE.Vector3(0, 0, -1)), [first, second], {
      isCurrent: () => current, now: () => (clock += 4),
      yieldToPaint: async () => { current = false; },
    });
    expect(hits).toBeNull();
    expect(secondRaycast).not.toHaveBeenCalled();
  });

  it('does no work for a stale model and returns an empty current result for no meshes', async () => {
    const mesh = plane(0);
    const raycast = vi.spyOn(mesh, 'raycast');
    const yieldToPaint = vi.fn(async () => undefined);
    expect(await intersectMeshesInSlices(new THREE.Raycaster(), [mesh], { isCurrent: () => false, yieldToPaint })).toBeNull();
    expect(await intersectMeshesInSlices(new THREE.Raycaster(), [], { isCurrent: () => true, yieldToPaint })).toEqual([]);
    expect(raycast).not.toHaveBeenCalled();
    expect(yieldToPaint).not.toHaveBeenCalled();
  });
});
