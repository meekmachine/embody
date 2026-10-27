import { CanvasTexture, Color, EquirectangularReflectionMapping, Group, LoadingManager, SRGBColorSpace, TextureLoader } from 'three';
import type { BufferGeometry, Material, Object3D, Scene, Texture } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { CharacterSceneRenderingController } from './scene';
import { acquireSceneBackground } from './sceneBackground';

/** World coordinates in the scene's native units (Y up for default character scenes). */
export type SceneSceneryPosition = { x: number; y: number; z: number };
export type SceneSceneryInstance = { instanceId: string; assetId: string; position: SceneSceneryPosition };
export type SceneScenerySkybox = {
  kind: 'skybox' | 'backdrop' | 'color';
  assetId: string | null;
  /** Six-digit #rrggbb, also used by the generated sky when assetId is null. */
  color: string;
  intensity: number;
  /** Y-axis degrees. Applies to equirectangular skyboxes. */
  rotation: number;
};
export type SceneSceneryLayout = { skybox: SceneScenerySkybox | null; instances: readonly SceneSceneryInstance[] };
export type SceneSceneryAsset = { bytes: ArrayBuffer; contentType: string };
export type SceneSceneryRendererOptions = {
  scene: Scene;
  /** The scene's existing controller. Omit only for an externally managed scene. */
  rendering?: CharacterSceneRenderingController | null;
  /** Storage authorization, caching and asset identities remain with the caller. */
  loadAsset(assetId: string, signal: AbortSignal): Promise<SceneSceneryAsset>;
  onError?: (message: string) => void;
};
export type SceneSceneryRenderer = {
  /** Validates and copies the entire layout before changing the current selection. */
  update(layout: SceneSceneryLayout | null): void;
  /** Cancels loads, drains borrowed rendering work, and releases only scenery. */
  dispose(): Promise<void>;
};

type Display = { texture: Texture | null; value: Texture | Color; intensity: number; rotation: number; dispose(): void };
type Model = { assetId: string; wrapper: Group; controller: AbortController; roots: Object3D[]; attached: boolean; retired: boolean };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

function copyLayout(layout: SceneSceneryLayout | null): SceneSceneryLayout {
  if (layout === null) return { skybox: null, instances: [] };
  if (!layout || !Array.isArray(layout.instances)) throw new Error('Scenery requires an instances array.');
  const ids = new Set<string>();
  const instances = layout.instances.map(instance => {
    if (!instance || !identity(instance.instanceId) || !identity(instance.assetId)) throw new Error('Each scenery placement requires an instanceId and assetId.');
    if (ids.has(instance.instanceId)) throw new Error(`Duplicate scenery instanceId: ${instance.instanceId}`);
    ids.add(instance.instanceId);
    const position = instance.position;
    if (!position || !finite(position.x) || !finite(position.y) || !finite(position.z)) throw new Error(`Scenery placement ${instance.instanceId} requires finite X/Y/Z coordinates.`);
    return { instanceId: instance.instanceId, assetId: instance.assetId, position: { x: position.x, y: position.y, z: position.z } };
  });
  const skybox = layout.skybox;
  if (skybox !== null) {
    if (!skybox || !['skybox', 'backdrop', 'color'].includes(skybox.kind)) throw new Error('Scenery background kind must be skybox, backdrop or color.');
    if (skybox.assetId !== null && !identity(skybox.assetId)) throw new Error('The scenery background assetId must be a nonempty string or null.');
    if (skybox.kind === 'color' && skybox.assetId !== null) throw new Error('A solid scenery color cannot use an image asset.');
    if (typeof skybox.color !== 'string' || !/^#[\da-f]{6}$/i.test(skybox.color)) throw new Error('Scenery background color must use six-digit #rrggbb.');
    if (!finite(skybox.intensity) || skybox.intensity < 0 || !finite(skybox.rotation)) throw new Error('Scenery background intensity must be nonnegative and rotation must be finite degrees.');
  }
  return { instances, skybox: skybox === null ? null : { kind: skybox.kind, assetId: skybox.assetId, color: skybox.color, intensity: skybox.intensity, rotation: skybox.rotation } };
}

function disposeRoots(roots: readonly Object3D[]) {
  const geometries = new Set<BufferGeometry>(), materials = new Set<Material>(), textures = new Set<Texture>();
  const skeletons = new Set<{ dispose(): void }>();
  for (const root of roots) root.traverse((object: any) => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.skeleton) skeletons.add(object.skeleton);
    for (const material of object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : []) {
      materials.add(material);
      for (const value of Object.values(material) as any[]) if (value?.isTexture) textures.add(value);
    }
  });
  const images = new Set<any>();
  for (const texture of textures) {
    for (const image of Array.isArray(texture.image) ? texture.image : [texture.image]) if (image) images.add(image);
    texture.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const image of images) image.close?.();
}

function display(value: Color | Texture, skybox: SceneScenerySkybox): Display {
  const texture = 'isTexture' in value ? value as Texture : null;
  if (texture) { texture.colorSpace = SRGBColorSpace; if (skybox.kind === 'skybox') texture.mapping = EquirectangularReflectionMapping; }
  let disposed = false;
  return { value, texture, intensity: skybox.intensity, rotation: skybox.kind === 'skybox' ? skybox.rotation : 0,
    dispose() { if (disposed) return; disposed = true; texture?.dispose(); } };
}

function generatedSky(skybox: SceneScenerySkybox): Display {
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser could not create the scenery skybox.');
  const gradient = context.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#10172c'); gradient.addColorStop(.48, skybox.color);
  gradient.addColorStop(.52, '#b6aaa0'); gradient.addColorStop(1, '#151c25');
  context.fillStyle = gradient; context.fillRect(0, 0, 1024, 512);
  return display(new CanvasTexture(canvas), skybox);
}

async function imageDisplay(asset: SceneSceneryAsset, skybox: SceneScenerySkybox): Promise<Display> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.contentType)) throw new Error('Scenery backgrounds require a PNG, JPEG or WebP image.');
  const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.contentType }));
  let pending: Texture | undefined;
  try {
    const texture = await new Promise<Texture>((resolve, reject) => {
      pending = new TextureLoader().load(url, resolve, undefined, reject);
    });
    return display(texture, skybox);
  } catch (error) {
    pending?.dispose();
    throw new Error(`Scenery background image could not decode: ${messageOf(error)}`);
  } finally { URL.revokeObjectURL(url); }
}

async function parseModel(asset: SceneSceneryAsset): Promise<Object3D[]> {
  if (asset.contentType !== 'model/gltf-binary' || asset.bytes.byteLength < 20) throw new Error('Scenery models require a self-contained GLB 2.0 file.');
  const header = new DataView(asset.bytes);
  if (header.getUint32(0, true) !== 0x46546c67 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== asset.bytes.byteLength) throw new Error('Scenery models require a valid GLB 2.0 container.');
  let offset = 12, document: { buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[] } | undefined;
  while (offset < asset.bytes.byteLength) {
    if (offset + 8 > asset.bytes.byteLength) throw new Error('The scenery GLB has a truncated chunk header.');
    const size = header.getUint32(offset, true), kind = header.getUint32(offset + 4, true);
    if (size % 4 || size > asset.bytes.byteLength - offset - 8) throw new Error('The scenery GLB has an invalid chunk length.');
    if (offset === 12 && kind !== 0x4e4f534a) throw new Error('The scenery GLB must begin with its JSON chunk.');
    if (kind === 0x4e4f534a) {
      if (document) throw new Error('The scenery GLB contains duplicate JSON chunks.');
      try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(asset.bytes, offset + 8, size))); }
      catch (error) { throw new Error(`The scenery GLB JSON is invalid: ${messageOf(error)}`); }
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('The scenery GLB JSON must be an object.');
    }
    offset += 8 + size;
  }
  // Uploaded blob: references are external too. Only the loader's own generated
  // blob URLs for embedded bufferView images may pass the URL modifier below.
  for (const resources of [document?.buffers, document?.images]) {
    if (resources !== undefined && !Array.isArray(resources)) throw new Error('The scenery GLB buffers and images must be arrays.');
    for (const resource of resources ?? []) {
      if (resource?.uri !== undefined && (typeof resource.uri !== 'string' || !resource.uri.startsWith('data:'))) {
        throw new Error('Scenery GLB files must embed their geometry and textures; external URLs are not allowed.');
      }
    }
  }
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    throw new Error('Scenery GLB files must embed their geometry and textures; external URLs are not allowed.');
  });
  const gltf = await new GLTFLoader(manager).parseAsync(asset.bytes, '');
  if (!gltf.scene?.isObject3D) throw new Error('The scenery GLB has no scene to display.');
  return [gltf.scene, ...gltf.scenes.filter(root => root !== gltf.scene)];
}

/** Native scene resources only: no storage, character selection, mixer or render loop. */
export function createSceneSceneryRenderer(options: SceneSceneryRendererOptions): SceneSceneryRenderer {
  const { scene, rendering, loadAsset } = options;
  if (!scene?.isScene || typeof loadAsset !== 'function') throw new Error('Scenery requires a Three scene and an asset loader.');
  let disposed = false, disposal: Promise<void> | null = null;
  let backgroundKey: string | null = null, backgroundGeneration = 0;
  let backgroundLoad: AbortController | null = null, currentDisplay: Display | null = null;
  const models = new Map<string, Model>(), tasks = new Set<Promise<void>>();
  const report = (message: string) => { try { options.onError?.(message); } catch (error) { console.error('Scenery error subscriber failed.', error); } };
  const track = (task: Promise<void>) => {
    tasks.add(task);
    void task.then(() => tasks.delete(task), error => { tasks.delete(task); report(messageOf(error)); });
    return task;
  };
  const release = (callback: () => void): Promise<void> => {
    try { return rendering ? rendering.releaseSceneResources(callback) : (callback(), Promise.resolve()); }
    catch (error) { return Promise.reject(error); }
  };
  const background = acquireSceneBackground(scene, () => { void dispose().catch(error => report(messageOf(error))); });
  const retire = (model: Model): Promise<void> => {
    if (model.retired) return Promise.resolve();
    model.retired = true; model.controller.abort();
    return release(() => {
      model.wrapper.removeFromParent(); model.attached = false;
      disposeRoots(model.roots); model.roots = [];
    });
  };
  const mount = (instance: SceneSceneryInstance) => {
    const wrapper = new Group(); wrapper.name = `Scenery ${instance.instanceId}`;
    wrapper.position.set(instance.position.x, instance.position.y, instance.position.z);
    const model: Model = { assetId: instance.assetId, wrapper, controller: new AbortController(), roots: [], attached: false, retired: false };
    models.set(instance.instanceId, model);
    track((async () => {
      let roots: Object3D[] = [];
      try {
        const asset = await loadAsset(model.assetId, model.controller.signal);
        if (model.controller.signal.aborted) return;
        roots = await parseModel(asset);
        if (model.controller.signal.aborted || disposed) { disposeRoots(roots); roots = []; return; }
        await release(() => {
          if (model.controller.signal.aborted || disposed) { disposeRoots(roots); roots = []; return; }
          model.roots = roots; roots = [];
          wrapper.add(model.roots[0]); scene.add(wrapper); model.attached = true;
        });
      } catch (error) {
        if (roots.length) disposeRoots(roots);
        if (!model.controller.signal.aborted && !disposed) {
          if (models.get(instance.instanceId) === model) models.delete(instance.instanceId);
          await retire(model);
          report(`Scenery placement ${instance.instanceId} could not load: ${messageOf(error)}`);
        }
      }
    })());
  };
  const updateBackground = (skybox: SceneScenerySkybox | null) => {
    const key = JSON.stringify(skybox);
    if (backgroundKey === key) return;
    backgroundKey = key; const generation = ++backgroundGeneration;
    backgroundLoad?.abort(); const controller = new AbortController(); backgroundLoad = controller;
    track((async () => {
      let next: Display | null = null;
      try {
        if (skybox) {
          if (skybox.kind === 'color') next = display(new Color(skybox.color), skybox);
          else if (!skybox.assetId) next = generatedSky(skybox);
          else {
            const asset = await loadAsset(skybox.assetId, controller.signal);
            if (controller.signal.aborted) return;
            next = await imageDisplay(asset, skybox);
          }
        }
        await release(() => {
          if (controller.signal.aborted || generation !== backgroundGeneration || disposed) { next?.dispose(); next = null; return; }
          if (next) background.set(next.value, next.intensity, next.rotation); else background.clear();
          const previous = currentDisplay; currentDisplay = next; next = null;
          previous?.dispose();
        });
      } catch (error) {
        next?.dispose();
        if (!controller.signal.aborted && generation === backgroundGeneration && !disposed) {
          backgroundKey = null;
          report(`Scenery background could not load: ${messageOf(error)}`);
        }
      }
    })());
  };
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposed = true; backgroundGeneration++; backgroundLoad?.abort();
    // Release logical background ownership now so effect cleanup/recreation can
    // acquire the same scene. GPU resources stay alive until the drain below.
    background.dispose();
    const releases = [...models.values()].map(retire); models.clear();
    releases.push(release(() => { currentDisplay?.dispose(); currentDisplay = null; }));
    disposal = (async () => {
      const results = await Promise.allSettled([...tasks, ...releases]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return disposal;
  }
  return {
    update(value) {
      if (disposed) throw new Error('The scenery renderer has been disposed.');
      const layout = copyLayout(value);
      const next = new Map(layout.instances.map(instance => [instance.instanceId, instance]));
      for (const [id, model] of models) if (next.get(id)?.assetId !== model.assetId) { models.delete(id); track(retire(model)); }
      for (const instance of layout.instances) {
        const current = models.get(instance.instanceId);
        if (current) current.wrapper.position.set(instance.position.x, instance.position.y, instance.position.z);
        else mount(instance);
      }
      updateBackground(layout.skybox);
    },
    dispose,
  };
}
