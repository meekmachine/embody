import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterConfig, Region } from '../types';

const paint = vi.hoisted(() => ({ pending: [] as Array<() => void> }));
vi.mock('../loadFrame', () => ({
  waitForCharacterLoadPaint: () => new Promise<void>((resolve) => paint.pending.push(resolve)),
}));
import { DPthree3DMarkers } from '../DPthree3DMarkers';

const active: DPthree3DMarkers[] = [];
function fixture() {
  const model = new THREE.Group();
  for (const z of [-1, 0, 1]) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.position.z = z; model.add(mesh);
  }
  const bone = new THREE.Bone(); bone.name = 'Head'; model.add(bone);
  const markers = new DPthree3DMarkers({
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    domElement: { addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLElement,
    onSelect: vi.fn(),
  });
  active.push(markers);
  markers.setModel(model);
  // Isolate surface work from unrelated preset discovery and canvas labels.
  vi.spyOn(markers as any, 'getRegionCenterAndBox').mockImplementation((region: Region) => ({
    center: region.customPosition
      ? new THREE.Vector3(region.customPosition.x, region.customPosition.y, region.customPosition.z)
      : new THREE.Vector3(),
    box: new THREE.Box3(),
  }));
  vi.spyOn(markers as any, 'findPrimaryBone').mockReturnValue(bone);
  vi.spyOn(markers as any, 'getOutwardDirection').mockReturnValue(new THREE.Vector3(0, 0, 1));
  vi.spyOn(markers as any, 'createLabelSprite').mockImplementation(() => new THREE.Sprite(new THREE.SpriteMaterial()));
  const config: CharacterConfig = {
    characterId: 'marker-test', characterName: 'Marker Test', modelPath: 'test.glb',
    regions: [{ name: 'control', bones: ['Head'] }],
  };
  return { markers, internals: markers as any, config, model, bone };
}

async function finishPaints<T>(task: Promise<T>): Promise<T> {
  let finished = false;
  void task.then(() => { finished = true; });
  await vi.waitFor(() => {
    paint.pending.splice(0).forEach((resolve) => resolve());
    expect(finished).toBe(true);
  }, { interval: 1 });
  return task;
}

beforeEach(() => {
  paint.pending = [];
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  active.splice(0).forEach((markers) => markers.dispose());
  paint.pending.splice(0).forEach((resolve) => resolve());
  vi.restoreAllMocks();
});

describe('initial marker surface slicing', () => {
  it('waits between mesh queries and commits identical placement and bone attachment only when complete', async () => {
    const { markers, internals, config, bone } = fixture();
    const expected = internals.findSurfacePoint(new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
    const loading = markers.loadRegions(config, { sliceSurfaceQueries: true });
    await vi.waitFor(() => expect(paint.pending).toHaveLength(1));
    expect(internals.markerMeshes.size).toBe(0);
    expect(internals.boneRefs.size).toBe(0);
    expect(internals.localOffsets.size).toBe(0);
    // Clicks and one-off edits use this raycaster; they must not redirect the
    // initial projection while its own native queries are suspended.
    internals.raycaster.set(new THREE.Vector3(100, 100, 100), new THREE.Vector3(1, 0, 0));
    await finishPaints(loading);
    expect(internals.markerMeshes.get('control').position.toArray()).toEqual(expected.toArray());
    expect(internals.boneRefs.get('control')).toBe(bone);
    expect(internals.localOffsets.get('control').toArray()).toEqual(expected.toArray());
  });

  it.each(['setModel', 'clear', 'dispose', 'secondLoad'])(
    '%s invalidates an in-flight projection without any stale marker commit', async (operation) => {
      const { markers, internals, config } = fixture();
      const loading = markers.loadRegions(config, { sliceSurfaceQueries: true });
      await vi.waitFor(() => expect(paint.pending).toHaveLength(1));
      if (operation === 'setModel') markers.setModel(new THREE.Group());
      if (operation === 'clear') markers.clear();
      if (operation === 'dispose') markers.dispose();
      if (operation === 'secondLoad') await markers.loadRegions({ ...config, regions: [{ name: 'replacement', bones: ['Head'] }] });
      await finishPaints(loading);
      expect(internals.markerMeshes.has('control')).toBe(false);
      expect(internals.boneRefs.has('control')).toBe(false);
      expect(internals.localOffsets.has('control')).toBe(false);
      expect(Array.from(internals.markerMeshes.keys())).toEqual(operation === 'secondLoad' ? ['replacement'] : []);
    },
  );

  it.each(['update', 'remove'])('does not overwrite a region after a synchronous %s during a yield', async (operation) => {
    const { markers, internals, config } = fixture();
    const loading = markers.loadRegions(config, { sliceSurfaceQueries: true });
    await vi.waitFor(() => expect(paint.pending).toHaveLength(1));
    if (operation === 'update') markers.updateRegion('control', { customPosition: { x: 0.5, y: 0.2, z: 0.1 } });
    else markers.removeRegion('control');
    const replacement = internals.markerMeshes.get('control');
    const children = [...internals.markerGroup.children];
    await finishPaints(loading);
    expect(internals.markerMeshes.get('control')).toBe(replacement);
    expect(internals.markerGroup.children).toEqual(children);
    expect(internals.markerMeshes.has('control')).toBe(operation === 'update');
  });

  it('keeps active reloads synchronous by default', async () => {
    const { markers, config, internals } = fixture();
    await markers.loadRegions(config);
    expect(paint.pending).toHaveLength(0);
    expect(internals.markerMeshes.has('control')).toBe(true);
    markers.updateRegion('control', { cameraAngle: 180 });
    expect(paint.pending).toHaveLength(0);
  });

  it.each([
    [0, 0, 0, 0, 0, 1], // nearest incoming surface
    [3, 0, 0, 0, 0, 1], // incoming misses; furthest fallback surface
    [3, 0, 0, 1, 0, 0], // both miss; scaled outward offset
  ])('matches the synchronous incoming/fallback selection for target (%s,%s,%s)', async (...values) => {
    const { internals } = fixture();
    const target = new THREE.Vector3(values[0], values[1], values[2]);
    const direction = new THREE.Vector3(values[3], values[4], values[5]);
    const expected = internals.findSurfacePoint(target, direction);
    const actual = await finishPaints(internals.findSurfacePointInSlices(target, direction, () => true));
    expect((actual as THREE.Vector3).toArray()).toEqual(expected.toArray());
  });
});
