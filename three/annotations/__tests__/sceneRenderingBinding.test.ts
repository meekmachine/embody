import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CharacterSceneRenderingController, CharacterSceneRenderingSnapshot } from '../../scene';
import { registerSceneRendering } from '../../sceneRenderingBinding';
import { DPthreeCameraController } from '../DPthreeCameraController';
import { getAnnotationCameraCore } from '../annotationCameraCore';
beforeAll(async () => { await getAnnotationCameraCore(); });

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = new THREE.Vector3();
    connect = vi.fn(); disconnect = vi.fn(); update() {} dispose() {}
  },
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const container = { clientWidth: 640, clientHeight: 480, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as HTMLElement;
  const makeRenderer = () => {
    let callback: (() => void) | null = null;
    const renderer = {
      domElement: { parentElement: container, addEventListener: vi.fn(), removeEventListener: vi.fn() },
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
  };
  const owner = registerSceneRendering(rendering, scene, camera, () => null, reportFailure);
  return { scene, camera, container, makeRenderer, first, owner, rendering, reportFailure };
}

describe('camera binding to scene-owned renderer settings', () => {
  it('retargets the one loop and OrbitControls without replacing the camera, model or control state', async () => {
    const f = fixture(), rendered: THREE.WebGLRenderer[] = [];
    const controller = new DPthreeCameraController({ scene: f.scene, camera: f.camera, domElement: f.container,
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
    expect(f.camera.position.toArray()).toEqual([2, 3, 4]); expect(controls.target.toArray()).toEqual([.1, .2, .3]);
    expect(controls.connect).toHaveBeenLastCalledWith(second.renderer.domElement);
    controller.dispose();
  });

  it('suspension waits for a borrowed asynchronous frame and rejects queued model preparation', async () => {
    const f = fixture(); let finish!: () => void;
    const frame = new Promise<void>((resolve) => { finish = resolve; });
    const controller = new DPthreeCameraController({ scene: f.scene, camera: f.camera, domElement: f.container,
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
    const controller = new DPthreeCameraController({ scene: f.scene, camera: f.camera, domElement: f.container,
      rendering: f.rendering, showDOMControls: false });
    controller.setModel(new THREE.Group()); controller.clearModel();
    const second = f.makeRenderer();
    await f.owner.binding!.suspend(); await f.owner.binding!.prepare(second.renderer);
    expect(second.renderer.render).toHaveBeenCalledWith(f.scene, f.camera);
    controller.dispose();
  });

  it('bound render failures enter scene recovery instead of the legacy fatal host callback', async () => {
    const f = fixture(), failure = new Error('device stopped rendering'), fatal = vi.fn();
    const controller = new DPthreeCameraController({ scene: f.scene, camera: f.camera, domElement: f.container,
      rendering: f.rendering, showDOMControls: false, onRenderError: fatal, renderFrame: () => { throw failure; } });
    f.first.tick();
    expect(f.reportFailure).toHaveBeenCalledWith(failure, f.first.renderer); expect(fatal).not.toHaveBeenCalled();
    expect(f.first.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
    controller.dispose();
  });
});
