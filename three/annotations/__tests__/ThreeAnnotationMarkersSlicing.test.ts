import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterConfig } from '../types';
import { installAnnotationDom } from './annotationDom';
const paint = vi.hoisted(() => ({ pending: [] as Array<() => void> }));
vi.mock('../loadFrame', () => ({ waitForCharacterLoadPaint: () => new Promise<void>(resolve => paint.pending.push(resolve)) }));
import { ThreeAnnotationMarkers } from '../ThreeAnnotationMarkers';

const active: ThreeAnnotationMarkers[] = [];
function fixture() {
  const { domElement } = installAnnotationDom(); const scene = new THREE.Scene();
  const model = new THREE.Group();
  for (const z of [-1, 0, 1]) { const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); mesh.position.z = z; model.add(mesh); }
  const bone = new THREE.Bone(); bone.name = 'Head'; model.add(bone);
  const markers = new ThreeAnnotationMarkers({ scene, camera: new THREE.PerspectiveCamera(), domElement, onSelect: vi.fn() });
  active.push(markers); markers.setModel(model);
  const config: CharacterConfig = { characterId: 'surface', regions: [{ name: 'head', bones: ['Head'], style: { lineDirection: 'forward' } }] };
  return { markers, config, model, bone, scene };
}
async function finishPaints<T>(task: Promise<T>): Promise<T> {
  let finished = false; void task.then(() => { finished = true; });
  await vi.waitFor(() => { paint.pending.splice(0).forEach(resolve => resolve()); expect(finished).toBe(true); }, { interval: 1 });
  return task;
}
beforeEach(() => { paint.pending = []; let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5)); });
afterEach(() => { active.splice(0).forEach(markers => markers.dispose()); paint.pending.splice(0).forEach(resolve => resolve()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('native raycast slicing with Rust placement and cancellation', () => {
  it('produces the same surface anchor as synchronous loading and follows the native bone', async () => {
    const sync = fixture(); await sync.markers.loadRegions(sync.config); const expected = sync.markers.getMarkerPosition('head')!;
    const sliced = fixture(); const loading = sliced.markers.loadRegions(sliced.config, { sliceSurfaceQueries: true });
    expect(paint.pending).toHaveLength(1);
    await finishPaints(loading);
    expect(sliced.markers.getMarkerPosition('head')!.toArray()).toEqual(expected.toArray());
    expect(expected.z).toBeGreaterThan(1);
    sliced.bone.position.x = 0.25; sliced.markers.update();
    expect(sliced.markers.getMarkerPosition('head')!.x).toBeCloseTo(expected.x + 0.25);
  });
  it.each(['setModel', 'clear', 'dispose', 'secondLoad'] as const)('%s invalidates a pending native query', async operation => {
    const { markers, config } = fixture(); const loading = markers.loadRegions(config, { sliceSurfaceQueries: true });
    expect(paint.pending).toHaveLength(1);
    if (operation === 'setModel') markers.setModel(new THREE.Group());
    if (operation === 'clear') markers.clear();
    if (operation === 'dispose') markers.dispose();
    if (operation === 'secondLoad') await markers.loadRegions({ ...config, regions: [{ name: 'replacement', customPosition: { x: 0.2, y: 0.2, z: 0.2 } }] });
    await finishPaints(loading); expect(markers.getMarkerPosition('head')).toBeNull();
    if (operation === 'secondLoad') expect(markers.getMarkerPosition('replacement')).not.toBeNull();
  });
  it.each(['update', 'remove'] as const)('preserves a synchronous %s made while projection is suspended', async operation => {
    const { markers, config } = fixture(); const loading = markers.loadRegions(config, { sliceSurfaceQueries: true });
    expect(paint.pending).toHaveLength(1);
    if (operation === 'update') markers.updateRegion('head', { markerAnchor: { type: 'point', position: { x: 0.5, y: 0.2, z: 0.1 } } });
    else markers.removeRegion('head');
    const expected = markers.getMarkerPosition('head'); await finishPaints(loading);
    expect(markers.getMarkerPosition('head')).toEqual(expected);
  });
  it('keeps active region edits synchronous without paint yields', async () => {
    const { markers, config } = fixture(); await markers.loadRegions(config);
    markers.updateRegion('head', { cameraAngle: 180 }); expect(paint.pending).toHaveLength(0);
    expect(markers.getMarkerPosition('head')).not.toBeNull();
  });
});
