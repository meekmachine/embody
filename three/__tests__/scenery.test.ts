import { Color, Group, Mesh, MeshBasicMaterial, Scene, BoxGeometry, Texture } from 'three';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CharacterSceneRenderingController } from '../scene';
import { createSceneSceneryRenderer, type SceneSceneryAsset, type SceneSceneryLayout } from '../scenery';
import { setSceneBaseBackground } from '../sceneBackground';

const mocks = vi.hoisted(() => ({ parse: vi.fn(), managers: [] as any[], images: [] as any[] }));
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({ GLTFLoader: class {
  constructor(manager: unknown) { mocks.managers.push(manager); }
  parseAsync = mocks.parse;
} }));
vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');
  return { ...actual, TextureLoader: class {
    load(url: string, resolve: (texture: Texture) => void, _progress: unknown, reject: (error: Error) => void) {
      const texture = new actual.Texture(); mocks.images.push({ url, texture, resolve: () => resolve(texture), reject }); return texture;
    }
  } };
});
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const glb = (document: Record<string, unknown> = { asset: { version: '2.0' } }): SceneSceneryAsset => {
  const json = new TextEncoder().encode(JSON.stringify(document)), padded = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(20 + padded), header = new DataView(bytes);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.byteLength, true);
  header.setUint32(12, padded, true); header.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, padded).fill(0x20); new Uint8Array(bytes, 20, json.length).set(json);
  return { bytes, contentType: 'model/gltf-binary' };
};
const image = (): SceneSceneryAsset => ({ bytes: new ArrayBuffer(8), contentType: 'image/png' });
const color = (tone: string): SceneSceneryLayout => ({ instances: [], skybox: { kind: 'color', assetId: null, color: tone, intensity: 1, rotation: 0 } });
const sky = (assetId: string): SceneSceneryLayout => ({ instances: [], skybox: { kind: 'skybox', assetId, color: '#668cae', intensity: .8, rotation: 90 } });
const placements = (): SceneSceneryLayout => ({ skybox: null, instances: [
  { instanceId: 'left', assetId: 'tree', position: { x: -2, y: 0, z: 4 } },
  { instanceId: 'right', assetId: 'tree', position: { x: 2, y: 0, z: 4 } },
] });
function drainedRendering() {
  const queued: { release: () => void; resolve: () => void; reject: (error: unknown) => void }[] = [];
  const rendering = { releaseSceneResources: vi.fn((release: () => void) => new Promise<void>((resolve, reject) => { queued.push({ release, resolve, reject }); })) } as unknown as CharacterSceneRenderingController;
  const flush = async (index = 0) => {
    const item = queued.splice(index, 1)[0];
    if (item) { try { item.release(); item.resolve(); } catch (error) { item.reject(error); } }
    await settle();
  };
  return { rendering, queued, flush };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.managers.length = 0; mocks.images.length = 0;
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:scenery');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

it('preserves authored model transforms and moves repeated assets independently without another load', async () => {
  const roots: Group[] = [];
  mocks.parse.mockImplementation(async () => {
    const root = new Group(); root.position.set(1, 2, 3); root.scale.setScalar(2); roots.push(root);
    return { scene: root, scenes: [root] };
  });
  const scene = new Scene(), character = new Group(); scene.add(character);
  const loadAsset = vi.fn(async () => glb()), renderer = createSceneSceneryRenderer({ scene, loadAsset });
  const layout = placements(); renderer.update(layout); await settle();
  const wrappers = scene.children.filter(child => child !== character);
  expect(wrappers.map(item => item.position.toArray())).toEqual([[-2, 0, 4], [2, 0, 4]]);
  expect(roots.map(item => item.position.toArray())).toEqual([[1, 2, 3], [1, 2, 3]]);
  expect(roots.map(item => item.scale.toArray())).toEqual([[2, 2, 2], [2, 2, 2]]);
  layout.instances[0].position.x = 7; renderer.update(layout); await settle();
  expect(wrappers[0].position.x).toBe(7); expect(wrappers[1].position.x).toBe(2);
  expect(loadAsset).toHaveBeenCalledTimes(2);
  renderer.update({ ...layout, instances: [layout.instances[0]] }); await settle();
  expect(scene.children).toEqual([character, wrappers[0]]);
  await renderer.dispose(); expect(scene.children).toEqual([character]);
});

it('validates every placement before applying any part of a replacement layout', async () => {
  const scene = new Scene(), loadAsset = vi.fn(), renderer = createSceneSceneryRenderer({ scene, loadAsset });
  renderer.update(color('#123456')); await settle();
  const invalid = placements(); invalid.instances[1].instanceId = invalid.instances[0].instanceId;
  expect(() => renderer.update(invalid)).toThrow('Duplicate scenery instanceId');
  expect((scene.background as Color).getHexString()).toBe('123456'); expect(loadAsset).not.toHaveBeenCalled();
  const malformed = placements(); malformed.instances[1].position.z = NaN;
  expect(() => renderer.update(malformed)).toThrow('finite X/Y/Z');
  expect(() => renderer.update(color('bad-color'))).toThrow('six-digit');
  await renderer.dispose();
});

it('restores the latest inherited background after character settings change under a scenery override', async () => {
  const scene = new Scene(); setSceneBaseBackground(scene, new Color('#111111'));
  const renderer = createSceneSceneryRenderer({ scene, loadAsset: vi.fn() });
  renderer.update(color('#222222')); await settle();
  setSceneBaseBackground(scene, new Color('#333333'));
  expect((scene.background as Color).getHexString()).toBe('222222');
  renderer.update(null); await settle();
  expect((scene.background as Color).getHexString()).toBe('333333');
  expect(scene.backgroundIntensity).toBe(1); expect(scene.backgroundRotation.y).toBe(0);
  await renderer.dispose();
});

it('rejects a second live owner but permits immediate recreation while old texture cleanup drains', async () => {
  const scene = new Scene(); setSceneBaseBackground(scene, new Color('#111111'));
  const drain = drainedRendering(), first = createSceneSceneryRenderer({ scene, rendering: drain.rendering, loadAsset: async () => image() });
  expect(() => createSceneSceneryRenderer({ scene, loadAsset: vi.fn() })).toThrow('already has a scenery renderer');
  first.update(sky('clouds')); await settle(); mocks.images[0].resolve(); await settle(); await drain.flush();
  const texture = mocks.images[0].texture as Texture, released = vi.fn(); texture.addEventListener('dispose', released);
  const oldCleanup = first.dispose();
  expect((scene.background as Color).getHexString()).toBe('111111'); expect(released).not.toHaveBeenCalled();
  const second = createSceneSceneryRenderer({ scene, rendering: drain.rendering, loadAsset: vi.fn() });
  second.update(color('#abcdef'));
  // Deliberately settle the new lease before the retired owner's cleanup.
  await drain.flush(1); expect((scene.background as Color).getHexString()).toBe('abcdef');
  await drain.flush(); await oldCleanup;
  expect(released).toHaveBeenCalledTimes(1); expect((scene.background as Color).getHexString()).toBe('abcdef');
  const finalCleanup = second.dispose(); await drain.flush(); await finalCleanup;
});

it('cancels superseded downloads and releases a late parse without attaching it', async () => {
  const parse = deferred<{ scene: Group; scenes: Group[] }>(); mocks.parse.mockReturnValue(parse.promise);
  const scene = new Scene(), failure = vi.fn(), loadAsset = vi.fn(async () => glb());
  const renderer = createSceneSceneryRenderer({ scene, loadAsset, onError: failure });
  renderer.update({ ...placements(), instances: [placements().instances[0]] }); await settle();
  const geometry = new BoxGeometry(), material = new MeshBasicMaterial(), root = new Group(); root.add(new Mesh(geometry, material));
  const geometryDisposed = vi.fn(), materialDisposed = vi.fn();
  geometry.addEventListener('dispose', geometryDisposed); material.addEventListener('dispose', materialDisposed);
  const cleanup = renderer.dispose(); expect(loadAsset.mock.calls[0][1].aborted).toBe(true);
  parse.resolve({ scene: root, scenes: [root] }); await cleanup;
  expect(scene.children).toHaveLength(0); expect(failure).not.toHaveBeenCalled();
  expect(geometryDisposed).toHaveBeenCalledTimes(1); expect(materialDisposed).toHaveBeenCalledTimes(1);
});

it('does not parse a canceled loader result and rejects external model resources', async () => {
  const delivery = deferred<SceneSceneryAsset>(), scene = new Scene();
  const renderer = createSceneSceneryRenderer({ scene, loadAsset: () => delivery.promise });
  renderer.update({ ...placements(), instances: [placements().instances[0]] });
  const cleanup = renderer.dispose(); delivery.resolve(glb()); await cleanup; expect(mocks.parse).not.toHaveBeenCalled();
  mocks.parse.mockImplementation(async () => {
    const manager = mocks.managers.at(-1);
    manager.resolveURL('https://outside.invalid/tree.png');
  });
  const failure = vi.fn(), next = createSceneSceneryRenderer({ scene, loadAsset: async () => glb(), onError: failure });
  next.update({ ...placements(), instances: [placements().instances[0]] }); await settle();
  expect(failure).toHaveBeenCalledWith(expect.stringContaining('external URLs are not allowed'));
  expect(scene.children).toHaveLength(0); await next.dispose();
});

it('keeps newer backgrounds after late image decode and revokes every decoded URL', async () => {
  const scene = new Scene(), failure = vi.fn();
  const renderer = createSceneSceneryRenderer({ scene, loadAsset: async () => image(), onError: failure });
  renderer.update(sky('first')); await settle();
  renderer.update(color('#abcdef')); await settle();
  const released = vi.fn(); mocks.images[0].texture.addEventListener('dispose', released); mocks.images[0].resolve(); await settle();
  expect((scene.background as Color).getHexString()).toBe('abcdef'); expect(released).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:scenery'); expect(failure).not.toHaveBeenCalled();
  renderer.update(sky('broken')); await settle(); mocks.images[1].reject(new Error('invalid image')); await settle();
  expect((scene.background as Color).getHexString()).toBe('abcdef'); expect(failure).toHaveBeenCalledWith(expect.stringContaining('invalid image'));
  await renderer.dispose();
});

it.each(['buffers', 'images'])('rejects authored blob URLs in GLB %s before the native loader runs', async collection => {
  const scene = new Scene(), failure = vi.fn();
  const renderer = createSceneSceneryRenderer({ scene, onError: failure,
    loadAsset: async () => glb({ asset: { version: '2.0' }, [collection]: [{ uri: 'blob:outside-this-upload' }] }) });
  renderer.update({ skybox: null, instances: [placements().instances[0]] }); await settle();
  expect(mocks.parse).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledWith(expect.stringContaining('external URLs are not allowed'));
  expect(scene.children).toHaveLength(0); await renderer.dispose();
});

it('bounds GLB chunks before decoding JSON and permits embedded data URIs', async () => {
  const broken = glb(); new DataView(broken.bytes).setUint32(12, 0xffffffff, true);
  const scene = new Scene(), failure = vi.fn();
  const renderer = createSceneSceneryRenderer({ scene, onError: failure, loadAsset: async () => broken });
  renderer.update({ skybox: null, instances: [placements().instances[0]] }); await settle();
  expect(mocks.parse).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledWith(expect.stringContaining('invalid chunk length'));
  await renderer.dispose();
  const root = new Group(); mocks.parse.mockResolvedValue({ scene: root, scenes: [root] });
  const next = createSceneSceneryRenderer({ scene, loadAsset: async () => glb({ asset: { version: '2.0' }, images: [{ uri: 'data:image/png;base64,AA==' }] }) });
  next.update({ skybox: null, instances: [placements().instances[0]] }); await settle();
  expect(mocks.parse).toHaveBeenCalledTimes(1); expect(scene.children).toHaveLength(1); await next.dispose();
});

it('detaches and frees shared model resources once after borrowed renderer work drains', async () => {
  const scene = new Scene(), root = new Group(), otherScene = new Group();
  const geometry = new BoxGeometry(), texture = new Texture(), material = new MeshBasicMaterial({ map: texture });
  root.add(new Mesh(geometry, material)); otherScene.add(new Mesh(geometry, material));
  mocks.parse.mockResolvedValue({ scene: root, scenes: [root, otherScene] });
  const drain = drainedRendering(), renderer = createSceneSceneryRenderer({ scene, rendering: drain.rendering, loadAsset: async () => glb() });
  renderer.update({ skybox: null, instances: [placements().instances[0]] }); await settle();
  while (drain.queued.length) await drain.flush();
  expect(scene.children).toHaveLength(1);
  const geometryDisposed = vi.fn(), materialDisposed = vi.fn(), textureDisposed = vi.fn();
  geometry.addEventListener('dispose', geometryDisposed); material.addEventListener('dispose', materialDisposed); texture.addEventListener('dispose', textureDisposed);
  renderer.update(null);
  expect(scene.children).toHaveLength(1); expect(geometryDisposed).not.toHaveBeenCalled();
  while (drain.queued.length) await drain.flush();
  expect(scene.children).toHaveLength(0);
  expect(geometryDisposed).toHaveBeenCalledTimes(1); expect(materialDisposed).toHaveBeenCalledTimes(1); expect(textureDisposed).toHaveBeenCalledTimes(1);
  const cleanup = renderer.dispose(); while (drain.queued.length) await drain.flush(); await cleanup;
  expect(renderer.dispose()).toBe(cleanup);
});
