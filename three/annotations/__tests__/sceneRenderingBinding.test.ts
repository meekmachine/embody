import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CharacterSceneRenderingController, CharacterSceneRenderingSnapshot } from '../../scene';
import { registerSceneRendering } from '../../sceneRenderingBinding';
import { ThreeAnnotationController } from '../ThreeAnnotationController';
import { getAnnotationCameraCore } from '../annotationCameraCore';
import { installAnnotationDom, AnnotationElement, deferred } from './annotationDom';
beforeAll(async () => { await getAnnotationCameraCore(); });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(settled: () => Promise<unknown> | null = () => null) {
  const { host, domElement: container } = installAnnotationDom();
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const makeRenderer = () => {
    let callback: (() => void) | null = null;
    const canvas = new AnnotationElement(); host.appendChild(canvas);
    const renderer = {
      domElement: canvas,
      setAnimationLoop: vi.fn((frame: (() => void) | null) => { callback = frame; return Promise.resolve(); }),
      render: vi.fn(), setPixelRatio: vi.fn(), setSize: vi.fn(),
    };
    return { renderer: renderer as unknown as THREE.WebGLRenderer, tick: () => callback?.() };
  };
  const first = makeRenderer();
  const reportFailure = vi.fn();
  const snapshot: CharacterSceneRenderingSnapshot = { settings: { preference: 'webgl' }, backend: 'webgl', renderer: first.renderer, status: 'ready', error: null };
  const rendering: CharacterSceneRenderingController = {
    getSettings: () => snapshot.settings, getSnapshot: () => snapshot,
    setSettings: async () => snapshot, subscribe: () => () => {},
    acquireRenderer: () => ({ renderer: first.renderer, release() {} }),
    releaseSceneResources: async release => { release(); },
  };
  const owner = registerSceneRendering(rendering, scene, camera, settled, reportFailure);
  return { scene, camera, container, makeRenderer, first, owner, rendering, reportFailure };
}

describe('camera binding to scene-owned renderer settings', () => {
  it('retargets the one loop and native input controls without replacing the camera, model or control state', async () => {
    const f = fixture(), rendered: THREE.WebGLRenderer[] = [];
    const controller = new ThreeAnnotationController({ scene: f.scene, camera: f.camera, domElement: f.container,
      rendering: f.rendering, showDOMControls: false, renderFrame: (renderer) => { rendered.push(renderer as THREE.WebGLRenderer); } });
    const controls = controller.controls;
    const model = new THREE.Group(); controller.setModel(model);
    f.camera.position.set(2, 3, 4); controls.target.set(.1, .2, .3);
    const second = f.makeRenderer();
    await f.owner.binding!.suspend();
    f.first.tick(); expect(rendered).toEqual([]);
    await f.owner.binding!.commit(second.renderer);
    f.first.tick(); second.tick();
    expect(rendered).toEqual([second.renderer]); expect(controller.controls).toBe(controls);
    expect(f.camera.position.toArray()).toEqual([2, 3, 4]);
    controls.target.toArray().forEach((value, index) => expect(value).toBeCloseTo([.1, .2, .3][index]));
    expect(controls.domElement).toBe(second.renderer.domElement);
    const pose = controller.getCameraState();
    const wheel = () => Object.assign(new Event('wheel'), { deltaY: 100, deltaMode: 0 });
    f.first.renderer.domElement.dispatchEvent(wheel());
    expect(controller.getCameraState()).toEqual(pose);
    second.renderer.domElement.dispatchEvent(wheel());
    expect(controller.getCameraState()).not.toEqual(pose);
    controller.dispose();
  });

  it('suspension waits for a borrowed asynchronous frame and rejects queued model preparation', async () => {
    const f = fixture(); let finish!: () => void;
    const frame = new Promise<void>((resolve) => { finish = resolve; });
    const controller = new ThreeAnnotationController({ scene: f.scene, camera: f.camera, domElement: f.container,
      rendering: f.rendering, showDOMControls: false, renderFrame: () => frame });
    f.first.tick();
    let settled = false;
    const paused = f.owner.binding!.suspend().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    await expect(controller.prepareModelForRender(new THREE.Group())).rejects.toThrow(/renderer replacement/);
    finish(); await paused; controller.dispose();
  });

  it('clearing the model prevents the next backend preparation from touching removed resources', async () => {
    const f = fixture();
    const controller = new ThreeAnnotationController({ scene: f.scene, camera: f.camera, domElement: f.container,
      rendering: f.rendering, showDOMControls: false });
    controller.setModel(new THREE.Group()); controller.clearModel();
    const second = f.makeRenderer();
    await f.owner.binding!.suspend(); await f.owner.binding!.prepare(second.renderer);
    expect(second.renderer.render).toHaveBeenCalledWith(f.scene, f.camera);
    controller.dispose();
  });

  it('bound render failures enter scene recovery instead of the legacy fatal host callback', async () => {
    const f = fixture(), failure = new Error('device stopped rendering'), fatal = vi.fn();
    const controller = new ThreeAnnotationController({ scene: f.scene, camera: f.camera, domElement: f.container,
      rendering: f.rendering, showDOMControls: false, onRenderError: fatal, renderFrame: () => { throw failure; } });
    f.first.tick();
    expect(f.reportFailure).toHaveBeenCalledWith(failure, f.first.renderer); expect(fatal).not.toHaveBeenCalled();
    expect(f.first.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    controller.dispose();
  });

  it('drains an asynchronous frame before rejecting a failed loop shutdown', async () => {
    const f = fixture(); let finish!: () => void;
    const frame = new Promise<void>(resolve => { finish = resolve; });
    const controller = new ThreeAnnotationController({ scene: f.scene, camera: f.camera, domElement: f.container,
      rendering: f.rendering, showDOMControls: false, renderFrame: () => frame });
    f.first.tick();
    vi.mocked(f.first.renderer.setAnimationLoop).mockImplementationOnce(() => Promise.reject(new Error('device lost')));
    let settled = false;
    const stopped = f.owner.binding!.suspend().catch(error => { settled = true; expect(error.message).toBe('device lost'); });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    finish(); await stopped; expect(settled).toBe(true);
    controller.dispose();
  });
  it('retains native marker resources until the scene owner drains renderer work', async () => {
    const compiling = deferred(); const f = fixture(() => compiling.promise);
    const controller = new ThreeAnnotationController({ scene: f.scene, camera: f.camera, domElement: f.container,
      rendering: f.rendering, showDOMControls: false });
    controller.setModel(new THREE.Group());
    controller.prepareRegionsForReveal({ characterId: 'borrowed', regions: [{ name: 'point',
      markerAnchor: { type: 'point', position: { x: 0, y: 1, z: 0 } } }] });
    await controller.loadMarkersForCurrentRegions();
    const materials: THREE.Material[] = [];
    f.scene.traverse(object => {
      const material = (object as THREE.Mesh).material;
      if (material) materials.push(...(Array.isArray(material) ? material : [material]));
    });
    expect(materials.length).toBeGreaterThan(0);
    const released = deferred();
    const releases = materials.map(material => vi.spyOn(material, 'dispose'));
    releases[releases.length - 1].mockImplementation(() => { released.resolve(); });
    controller.dispose();
    for (const release of releases) expect(release).not.toHaveBeenCalled();
    compiling.resolve(); await released.promise;
    for (const release of releases) expect(release).toHaveBeenCalledOnce();
  });

});
