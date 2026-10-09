import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DPthreeCameraController } from '../DPthreeCameraController';

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    target = new THREE.Vector3();
    update() {} dispose() {}
  },
}));

function deferred() {
  let resolve!: () => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const controllers: DPthreeCameraController[] = [];
afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(native = true) {
  vi.stubGlobal('window', { innerWidth: 640, innerHeight: 480, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera();
  const model = new THREE.Group(); model.visible = false;
  const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.Texture() }));
  body.castShadow = true; body.layers.mask = 9; model.add(body);
  const sibling = body.clone(); model.add(sibling);
  const hidden = new THREE.Group(); hidden.visible = false; hidden.add(body.clone()); model.add(hidden);
  const receiver = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.ShadowMaterial()); receiver.receiveShadow = true; scene.add(receiver);
  const light = new THREE.DirectionalLight(); light.castShadow = true; light.shadow.autoUpdate = false; light.shadow.camera.layers.set(3); scene.add(light);
  const viewport = new THREE.Vector4(1, 2, 640, 480); const scissor = new THREE.Vector4(3, 4, 320, 240);
  let target: THREE.RenderTarget | null = null; let scissorTest = true;
  const clearColor = new THREE.Color(0x123456); let clearAlpha = 0.4;
  let renderObject = () => {}; let mrt = {};
  let callback: (() => void) | null = null;
  const renderer = {
    ...(native ? { isWebGPURenderer: true } : {}), hasInitialized: vi.fn(() => true),
    setAnimationLoop: vi.fn((value: (() => void) | null) => { callback = value; }),
    dispose: vi.fn(), setSize: vi.fn(), autoClear: true,
    shadowMap: { enabled: true, autoUpdate: false, needsUpdate: false },
    compileAsync: vi.fn(async (_model: THREE.Object3D, _camera: THREE.Camera, _scene: THREE.Scene) => {}),
    render: vi.fn(() => { light.shadow.needsUpdate = false; }),
    getRenderTarget: () => target, setRenderTarget: (value: THREE.RenderTarget | null) => { target = value; },
    getActiveCubeFace: () => 2, getActiveMipmapLevel: () => 1,
    getViewport: (value: THREE.Vector4) => value.copy(viewport),
    setViewport: (x: THREE.Vector4 | number, y?: number, w?: number, h?: number) => {
      if (x instanceof THREE.Vector4) viewport.copy(x); else viewport.set(x, y!, w!, h!);
    },
    getScissor: (value: THREE.Vector4) => value.copy(scissor), setScissor: (value: THREE.Vector4) => scissor.copy(value),
    getScissorTest: () => scissorTest, setScissorTest: (value: boolean) => { scissorTest = value; },
    getClearColor: (value: THREE.Color) => value.copy(clearColor), getClearAlpha: () => clearAlpha,
    setClearColor: (value: THREE.Color, alpha: number) => { clearColor.copy(value); clearAlpha = alpha; },
    getRenderObjectFunction: () => renderObject, setRenderObjectFunction: (value: () => void) => { renderObject = value; },
    getMRT: () => mrt, setMRT: (value: object) => { mrt = value; },
  };
  const renderFrame = vi.fn<() => void | Promise<void>>(); const onRenderError = vi.fn();
  const controller = new DPthreeCameraController({
    scene, camera, domElement: { clientWidth: 640, clientHeight: 480 } as HTMLElement,
    renderer: renderer as unknown as THREE.WebGLRenderer, renderFrame, onRenderError, showDOMControls: false,
  });
  controllers.push(controller); controller.setModel(model);
  return { controller, scene, camera, model, body, sibling, hidden, receiver, light, renderer, viewport, renderFrame, onRenderError, tick: () => callback?.() };
}

function expectRestored(f: ReturnType<typeof fixture>) {
  expect(f.model.parent).toBeNull(); expect(f.model.visible).toBe(false);
  expect(f.hidden.visible).toBe(false); expect(f.body.frustumCulled).toBe(true); expect(f.body.layers.mask).toBe(9);
  expect(f.viewport.toArray()).toEqual([1, 2, 640, 480]); expect(f.renderer.autoClear).toBe(true);
  expect(f.light.shadow.camera.layers.mask).toBe(8); expect(f.light.shadow.autoUpdate).toBe(false);
}

function skinnedTriangle() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3)];
  geometry.morphTargetsRelative = true;
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  const bone = new THREE.Bone(); mesh.add(bone); mesh.bind(new THREE.Skeleton([bone]));
  return { mesh, bone };
}

describe('controller model render readiness', () => {
  it('prepares joint indices when binding the model, before its first renderer frame', () => {
    const f = fixture(); const { mesh } = skinnedTriangle();
    const geometry = mesh.geometry, skeleton = mesh.skeleton;
    f.controller.setModel(mesh);
    expect(geometry.getAttribute('skinIndex').array).toBeInstanceOf(Float32Array);
    expect(mesh.geometry).toBe(geometry); expect(mesh.skeleton).toBe(skeleton);
    expect(f.renderer.compileAsync).not.toHaveBeenCalled();
    expect(f.renderer.render).not.toHaveBeenCalled();
  });

  it.each([false, true])('prepares separately supplied skinned models before compile (native=%s)', async (native) => {
    const f = fixture(native); const { mesh } = skinnedTriangle();
    const original = mesh.geometry.getAttribute('skinIndex');
    f.renderer.compileAsync.mockImplementationOnce(async model => {
      expect(model).toBe(mesh);
      const indices = mesh.geometry.getAttribute('skinIndex');
      expect(indices.array).toBeInstanceOf(Float32Array);
      expect(Array.from(indices.array)).toEqual(Array.from(original.array));
    });
    const readiness = f.controller.prepareModelForRender(mesh);
    await Promise.resolve(); f.tick(); await readiness;
    expect(mesh.parent).toBeNull(); expect(mesh.visible).toBe(true);
  });

  it.each([false, true])('compiles only the model and draws the complete scene once on the existing frame (native=%s)', async (native) => {
    const f = fixture(native); const compilation = deferred();
    const background = new THREE.Color(0xabcdef); f.scene.background = background;
    f.renderer.compileAsync.mockImplementationOnce((model, camera, scene) => {
      expect(model).toBe(f.model); expect(camera).toBe(f.camera); expect(scene).toBe(f.scene);
      expect(f.model.parent).toBe(f.scene); expect(f.model.visible).toBe(true); expect(f.hidden.visible).toBe(false);
      expect(f.body.frustumCulled).toBe(false); expect(f.body.layers.mask).toBe(9);
      return compilation.promise;
    });
    f.renderer.render.mockImplementation(() => {
      expect(f.model.parent).toBe(f.scene); expect(f.body.layers.mask).toBe(9); expect(f.sibling.layers.mask).toBe(9);
      expect(f.receiver.visible).toBe(true); expect(f.hidden.visible).toBe(false);
      expect(f.viewport.z).toBe(0); expect(f.viewport.w).toBe(0); expect(f.renderer.autoClear).toBe(false);
      expect(f.scene.background).toBeNull();
      expect(f.light.shadow.needsUpdate).toBe(true); f.light.shadow.needsUpdate = false;
    });
    const readiness = f.controller.prepareModelForRender(f.model);
    expectRestored(f); f.tick(); expect(f.renderFrame).toHaveBeenCalledOnce();
    compilation.resolve(); await compilation.promise;
    f.tick(); await readiness;
    expect(f.renderer.render).toHaveBeenCalledExactlyOnceWith(f.scene, f.camera);
    expect(f.renderFrame).toHaveBeenCalledOnce(); expectRestored(f);
    expect(f.scene.background).toBe(background);
    expect(f.light.shadow.needsUpdate).toBe(false);
    f.tick(); expect(f.renderFrame).toHaveBeenCalledTimes(2);
    expect(f.renderer.setAnimationLoop).toHaveBeenCalledOnce();
  });

  it.each(['resolve', 'reject'] as const)('waits for started compilation to %s after abort, with cancellation winning', async (outcome) => {
    const f = fixture(); const compilation = deferred(); const lifetime = new AbortController();
    f.renderer.compileAsync.mockReturnValueOnce(compilation.promise);
    const readiness = f.controller.prepareModelForRender(f.model, { signal: lifetime.signal });
    const result = readiness.catch((error: Error) => error);
    let settled = false; void result.then(() => { settled = true; });
    lifetime.abort(); await Promise.resolve(); expect(settled).toBe(false); expectRestored(f);
    if (outcome === 'resolve') compilation.resolve(); else compilation.reject(new Error('compile failed'));
    expect(await result).toMatchObject({ name: 'AbortError' });
    f.tick(); expect(f.renderer.render).not.toHaveBeenCalled();
  });

  it.each(['abort', 'dispose', 'setModel', 'clearMarkers'] as const)('cancels a draw waiting for a hidden-tab frame through %s', async (operation) => {
    const f = fixture(); const lifetime = new AbortController();
    const readiness = f.controller.prepareModelForRender(f.model, { signal: lifetime.signal });
    const rejected = expect(readiness).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    if (operation === 'abort') lifetime.abort();
    if (operation === 'dispose') f.controller.dispose();
    if (operation === 'setModel') f.controller.setModel(new THREE.Group());
    if (operation === 'clearMarkers') f.controller.clearMarkers();
    await rejected; expect(f.renderer.render).not.toHaveBeenCalled(); expectRestored(f);
  });

  it('serializes supersession behind outstanding compilation and only prepares the replacement', async () => {
    const f = fixture(); const compilation = deferred();
    f.renderer.compileAsync.mockReturnValueOnce(compilation.promise);
    const first = f.controller.prepareModelForRender(f.model).catch((error: Error) => error);
    const replacement = new THREE.Group(); replacement.add(f.body.clone());
    const second = f.controller.prepareModelForRender(replacement);
    expect(f.renderer.compileAsync).toHaveBeenCalledOnce();
    compilation.resolve(); expect(await first).toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(f.renderer.compileAsync).toHaveBeenCalledTimes(2));
    f.tick(); await second;
    expect(f.renderer.render).toHaveBeenCalledOnce();
    expect(f.renderer.compileAsync).toHaveBeenLastCalledWith(replacement, f.camera, f.scene);
    expect(replacement.parent).toBeNull(); expectRestored(f);
  });

  it('dispose stops the loop immediately but retains borrowed resources until compilation settles', async () => {
    const f = fixture(); const compilation = deferred(); f.renderer.compileAsync.mockReturnValueOnce(compilation.promise);
    const releaseGeometry = vi.spyOn(f.body.geometry, 'dispose');
    const readiness = f.controller.prepareModelForRender(f.model);
    const result = readiness.catch((error: Error) => error);
    let settled = false; void result.then(() => { settled = true; });
    f.controller.dispose(); await Promise.resolve();
    expect(f.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null); expect(settled).toBe(false);
    expect(releaseGeometry).not.toHaveBeenCalled(); expect(f.renderer.dispose).not.toHaveBeenCalled();
    compilation.resolve(); expect(await result).toMatchObject({ name: 'AbortError' });
    expect(releaseGeometry).not.toHaveBeenCalled(); expect(f.renderer.dispose).not.toHaveBeenCalled();
  });

  it('waits for an async host frame that starts while predecessor compilation settles', async () => {
    const f = fixture(); const compilation = deferred(); const hostFrame = deferred();
    f.renderer.compileAsync.mockReturnValueOnce(compilation.promise);
    const first = f.controller.prepareModelForRender(f.model).catch((error: Error) => error);
    const replacement = new THREE.Group();
    const second = f.controller.prepareModelForRender(replacement);
    f.renderFrame.mockReturnValueOnce(hostFrame.promise); f.tick();
    compilation.resolve(); expect(await first).toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); expect(f.renderer.compileAsync).toHaveBeenCalledOnce();
    hostFrame.resolve();
    await vi.waitFor(() => expect(f.renderer.compileAsync).toHaveBeenCalledTimes(2));
    f.tick(); await second;
    expect(f.renderer.render).toHaveBeenCalledOnce();
  });

  it.each(['throw', 'reject'] as const)('restores temporary model state after compile %s and allows retry', async (mode) => {
    const f = fixture(); const failure = new Error('pipeline failed');
    f.renderer.compileAsync.mockImplementationOnce(() => { if (mode === 'throw') throw failure; return Promise.reject(failure); });
    await expect(f.controller.prepareModelForRender(f.model)).rejects.toBe(failure); expectRestored(f);
    const retry = f.controller.prepareModelForRender(f.model); await Promise.resolve(); f.tick(); await retry;
    expect(f.renderer.render).toHaveBeenCalledOnce();
  });

  it('restores native nested-shadow state after a failed draw and leaves static maps dirty', async () => {
    const f = fixture(); const failure = new Error('shadow failed');
    f.scene.name = 'character'; const background = new THREE.Color(0xabcdef); f.scene.background = background;
    const override = new THREE.MeshBasicMaterial(); f.scene.overrideMaterial = override;
    const mrt = f.renderer.getMRT(); const renderObject = f.renderer.getRenderObjectFunction();
    f.renderer.render.mockImplementationOnce(() => {
      f.scene.name = 'shadow'; f.scene.background = null; f.scene.overrideMaterial = null;
      f.renderer.setRenderTarget(new THREE.RenderTarget()); f.renderer.setViewport(0, 0, 1024, 1024);
      f.renderer.setScissor(new THREE.Vector4()); f.renderer.setScissorTest(false);
      f.renderer.setClearColor(new THREE.Color(0), 0); f.renderer.setMRT({}); f.renderer.setRenderObjectFunction(() => {});
      f.light.shadow.camera.layers.set(0); throw failure;
    });
    const readiness = f.controller.prepareModelForRender(f.model); const rejected = expect(readiness).rejects.toBe(failure);
    await Promise.resolve(); f.tick(); await rejected;
    expectRestored(f); expect(f.light.shadow.needsUpdate).toBe(true);
    expect(f.scene.name).toBe('character'); expect(f.scene.background).toBe(background); expect(f.scene.overrideMaterial).toBe(override);
    expect(f.renderer.getRenderTarget()).toBeNull(); expect(f.renderer.getMRT()).toBe(mrt); expect(f.renderer.getRenderObjectFunction()).toBe(renderObject);
    expect(f.renderer.getScissor(new THREE.Vector4()).toArray()).toEqual([3, 4, 320, 240]); expect(f.renderer.getScissorTest()).toBe(true);
    expect(f.renderer.getClearColor(new THREE.Color()).getHex()).toBe(0x123456); expect(f.renderer.getClearAlpha()).toBe(0.4);
    expect(f.onRenderError).not.toHaveBeenCalled();
  });

  it('preserves a dirty static light when no receiving material refreshed its map', async () => {
    const f = fixture(); f.renderer.render.mockImplementationOnce(() => {});
    const readiness = f.controller.prepareModelForRender(f.model); await Promise.resolve(); f.tick(); await readiness;
    expect(f.light.shadow.needsUpdate).toBe(true); expect(f.light.shadow.autoUpdate).toBe(false);
  });

  it.each(['during draw', 'after draw'] as const)('invalidates completed static maps if cancellation arrives %s before readiness settles', async (when) => {
    const f = fixture(); const lifetime = new AbortController();
    f.renderer.render.mockImplementationOnce(() => {
      f.light.shadow.needsUpdate = false;
      if (when === 'during draw') lifetime.abort();
    });
    const readiness = f.controller.prepareModelForRender(f.model, { signal: lifetime.signal });
    const rejected = expect(readiness).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve(); f.tick();
    if (when === 'after draw') lifetime.abort();
    await rejected;
    expect(f.light.shadow.needsUpdate).toBe(true); expectRestored(f);
  });

  it('rejects invalid ownership or uninitialized native renderer without scheduling a frame', async () => {
    const f = fixture();
    await expect(f.controller.prepareModelForRender(f.scene)).rejects.toThrow('model, not the controller scene');
    const parent = new THREE.Group(); parent.add(f.model);
    await expect(f.controller.prepareModelForRender(f.model)).rejects.toThrow('detached model');
    f.scene.add(parent); parent.visible = false;
    await expect(f.controller.prepareModelForRender(f.model)).rejects.toThrow('visible model ancestors');
    parent.remove(f.model); f.renderer.hasInitialized.mockReturnValue(false);
    await expect(f.controller.prepareModelForRender(f.model)).rejects.toThrow('initialized WebGPU');
    expect(f.renderer.compileAsync).not.toHaveBeenCalled(); expect(f.renderer.render).not.toHaveBeenCalled();
  });

  it.each([false, true])('prepares lazy skinned bounds from the current bone/morph pose before unculling (native=%s)', async (native) => {
    const f = fixture(native); const { mesh, bone } = skinnedTriangle();
    f.model.add(mesh); bone.position.x = 4; mesh.morphTargetInfluences![0] = 0.5;
    expect(bone.matrixWorld.elements[12]).toBe(0); // Deliberately stale until preparation.
    const compute = vi.spyOn(mesh, 'computeBoundingSphere');
    f.renderer.render.mockImplementationOnce(() => {
      expect(mesh.frustumCulled).toBe(false);
      expect(compute).toHaveBeenCalledOnce();
      expect(mesh.boundingSphere!.center.x).toBeCloseTo(4);
      expect(mesh.boundingSphere!.containsPoint(mesh.getVertexPosition(0, new THREE.Vector3()))).toBe(true);
      expect(bone.matrixWorld.elements[12]).toBe(4);
      f.light.shadow.needsUpdate = false;
    });
    const readiness = f.controller.prepareModelForRender(f.model);
    expect(mesh.boundingSphere).toBeNull();
    await Promise.resolve(); f.tick(); await readiness;
    expect(mesh.frustumCulled).toBe(true);
    // Use Three's real first-visible culling path, without renderer mock help.
    const frustum = new THREE.Frustum();
    frustum.intersectsObject(mesh); frustum.intersectsObject(mesh);
    expect(compute).toHaveBeenCalledOnce();
    expectRestored(f);
  });

  it('initializes null geometry/instance spheres once while preserving authored bounds and hidden or unculled objects', async () => {
    const f = fixture();
    const geometryCompute = vi.spyOn(f.body.geometry, 'computeBoundingSphere');
    const instances = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial(), 2);
    instances.setMatrixAt(1, new THREE.Matrix4().makeTranslation(8, 0, 0));
    f.model.add(instances); const instanceCompute = vi.spyOn(instances, 'computeBoundingSphere');
    const preserved = skinnedTriangle().mesh;
    const authored = new THREE.Sphere(new THREE.Vector3(2, 3, 4), 20); preserved.boundingSphere = authored;
    f.model.add(preserved); const preservedCompute = vi.spyOn(preserved, 'computeBoundingSphere');
    const hidden = skinnedTriangle().mesh; f.hidden.add(hidden);
    const hiddenCompute = vi.spyOn(hidden, 'computeBoundingSphere');
    const unculled = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    unculled.frustumCulled = false; f.model.add(unculled);
    const unculledCompute = vi.spyOn(unculled.geometry, 'computeBoundingSphere');
    const readiness = f.controller.prepareModelForRender(f.model); await Promise.resolve(); f.tick(); await readiness;
    new THREE.Frustum().intersectsObject(instances); new THREE.Frustum().intersectsObject(f.body);
    expect(geometryCompute).toHaveBeenCalledOnce(); expect(instanceCompute).toHaveBeenCalledOnce();
    expect(instances.boundingSphere!.center.x).toBeCloseTo(4);
    expect(preserved.boundingSphere).toBe(authored); expect(preservedCompute).not.toHaveBeenCalled();
    expect(hiddenCompute).not.toHaveBeenCalled(); expect(hidden.boundingSphere).toBeNull();
    expect(unculledCompute).not.toHaveBeenCalled(); expect(unculled.frustumCulled).toBe(false);
  });

  it('restores model attachment/visibility when lazy bounds initialization fails', async () => {
    const f = fixture(); const failure = new Error('invalid skin data');
    vi.spyOn(f.body.geometry, 'computeBoundingSphere').mockImplementationOnce(() => { throw failure; });
    const readiness = f.controller.prepareModelForRender(f.model); const rejected = expect(readiness).rejects.toBe(failure);
    await Promise.resolve(); f.tick(); await rejected;
    expectRestored(f); expect(f.renderer.render).not.toHaveBeenCalled();
  });
});
