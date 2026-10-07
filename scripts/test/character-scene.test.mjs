import assert from 'node:assert/strict';
import { register } from 'node:module';
import test, { beforeEach } from 'node:test';
import { Group, WebGLCoordinateSystem, WebGPUCoordinateSystem } from 'three';

const entry = new URL(process.env.EMBODY_SCENE_SOURCE === '1' ? '../../three/scene.ts' : '../../dist/three.js', import.meta.url);
const fixture = new URL('../fixtures/character-scene/three.mjs', import.meta.url);
register('../fixtures/character-scene/loader.mjs', import.meta.url, { data: { entry: entry.href, fixture: fixture.href } });
const { control } = await import(fixture.href);
const { createDefaultCharacterScene, createDefaultCharacterSceneAsync, createDefaultCharacterSceneRuntime } = await import(entry.href);

beforeEach(() => control.reset());

const createWebGLSceneAsync = (host, options = {}) => createDefaultCharacterSceneAsync(host, { ...options, renderer: 'webgl' });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function container() {
  return {
    clientWidth: 640,
    clientHeight: 480,
    children: [],
    appendChild(child) { this.children.push(child); child.parentElement = this; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentElement = null; },
  };
}

function resizeEvents(t) {
  const callbacks = new Set();
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value(type, callback) {
    assert.equal(type, 'resize'); callbacks.add(callback);
  } });
  Object.defineProperty(globalThis, 'removeEventListener', { configurable: true, value(type, callback) {
    assert.equal(type, 'resize'); callbacks.delete(callback);
  } });
  t.after(() => {
    for (const key of ['addEventListener', 'removeEventListener']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  });
  return callbacks;
}

function assertReleased(host, callbacks) {
  assert.equal(host.children.length, 0);
  assert.equal(callbacks.size, 0);
  for (const renderer of control.renderers) assert.equal(renderer.disposeCount, 1);
  for (const pmrem of control.pmrems) assert.equal(pmrem.disposeCount, 1);
  for (const environment of control.environments) assert.equal(environment.disposeCount, 1);
  for (const scene of control.scenes) {
    assert.equal(scene.environment, null);
    assert.equal(scene.children.length, 0);
  }
}

test('async readiness waits for real scene preparation before attaching and uses the latest size', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const gate = deferred();
  control.prepare = () => gate.promise;
  let settled = false;
  const pending = createWebGLSceneAsync(host).then((value) => { settled = true; return value; });
  await Promise.resolve();
  const renderer = control.renderers[0];
  assert.equal(renderer.compileCount, 1);
  assert.equal(renderer.scene.environment, control.environments[0].texture);
  assert.equal(renderer.scene.children.length, 5); // Lights and shadow plane precede compile.
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(host.children.length, 0);
  assert.equal(callbacks.size, 0);
  host.clientWidth = 900;
  gate.resolve();
  const handle = await pending;
  assert.equal(handle.backend, 'webgl');
  assert.equal(handle.ownsScene, true);
  assert.equal(handle.renderer, renderer);
  assert.equal(handle.camera.aspect, 900 / 480);
  assert.deepEqual(renderer.sizes.at(-1), [900, 480, false]);
  assert.deepEqual(host.children, [renderer.domElement]);
  assert.equal(callbacks.size, 1);

  let geometryDisposed = 0, materialDisposed = 0;
  handle.shadowPlane.geometry.addEventListener('dispose', () => geometryDisposed++);
  handle.shadowPlane.material.addEventListener('dispose', () => materialDisposed++);
  handle.dispose();
  handle.dispose();
  handle.resize();
  assertReleased(host, callbacks);
  assert.equal(geometryDisposed, 1);
  assert.equal(materialDisposed, 1);
});

test('already aborted requests reject with AbortError before acquiring a renderer', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const controller = new AbortController();
  controller.abort('caller reason');
  await assert.rejects(createWebGLSceneAsync(host, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(control.renderers.length, 0);
  assertReleased(host, callbacks);
});

test('abort during compilation waits for settlement, then rolls back without attaching', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const gate = deferred();
  const controller = new AbortController();
  control.prepare = () => gate.promise;
  const pending = createWebGLSceneAsync(host, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await Promise.resolve();
  controller.abort();
  await Promise.resolve();
  assert.equal(control.renderers[0].disposeCount, 0, 'do not dispose while Three still polls its programs');
  assert.equal(host.children.length, 0);
  assert.equal(callbacks.size, 0);
  gate.resolve();
  await rejected;
  assertReleased(host, callbacks);
});

test('abort after readiness does not take ownership of the returned scene', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const controller = new AbortController();
  const handle = await createWebGLSceneAsync(host, { signal: controller.signal });
  controller.abort();
  assert.equal(host.children.length, 1);
  assert.equal(handle.renderer.disposeCount, 0);
  handle.dispose();
  assertReleased(host, callbacks);
});

for (const stage of ['constructor', 'size', 'pmremConstructor', 'environment', 'compile']) {
  test(`a synchronous ${stage} failure rejects with the original error and releases acquired resources`, async (t) => {
    const callbacks = resizeEvents(t);
    const host = container();
    const failure = new Error(stage);
    control.failure[stage] = failure;
    await assert.rejects(createWebGLSceneAsync(host), (error) => error === failure);
    assertReleased(host, callbacks);
  });
}

test('async compilation rejection preserves the original error even when disposal fails', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const failure = new Error('preparation rejected');
  control.prepare = () => Promise.reject(failure);
  control.failure.dispose = new Error('cleanup failed');
  await assert.rejects(createWebGLSceneAsync(host), (error) => error === failure);
  assertReleased(host, callbacks);
});

test('cancellation wins over a simultaneous preparation rejection after rollback', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const gate = deferred();
  const compilationStarted = deferred();
  const controller = new AbortController();
  control.prepare = () => { compilationStarted.resolve(); return gate.promise; };
  const pending = createWebGLSceneAsync(host, { signal: controller.signal });
  const failure = new Error('compile failed');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  // Exercise cancellation of borrowed compilation, not cancellation before the
  // queued renderer attempt starts (which would leave this gate unconsumed).
  await compilationStarted.promise;
  controller.abort();
  gate.reject(failure);
  await rejected;
  assertReleased(host, callbacks);
});

test('older renderers without compileAsync fail clearly and release the scene', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  control.failure.missingCompileAsync = true;
  await assert.rejects(createWebGLSceneAsync(host), /require Three.js WebGLRenderer.compileAsync/);
  assertReleased(host, callbacks);
});

test('normal disposal continues after a resource throws and cannot reacquire lighting', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const handle = await createWebGLSceneAsync(host);
  const failure = new Error('material disposal failed');
  handle.shadowPlane.material.addEventListener('dispose', () => { throw failure; });
  await assert.rejects(handle.dispose(), (error) => error === failure);
  await assert.rejects(handle.dispose(), (error) => error === failure);
  assert.throws(() => handle.lighting.setSettings({ environmentBlur: 0 }), /has been disposed/);
  assert.throws(() => handle.lighting.subscribe(() => {}), /has been disposed/);
  assertReleased(host, callbacks);
});

test('attachment failure rolls back already attached canvas and resources', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const failure = new Error('listener failed');
  Object.defineProperty(globalThis, 'addEventListener', { configurable: true, value(type, callback) {
    callbacks.add(callback); throw failure;
  } });
  await assert.rejects(createWebGLSceneAsync(host), (error) => error === failure);
  assertReleased(host, callbacks);
});

test('disabled resize management and the void scene retain their settings', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const handle = await createWebGLSceneAsync(host, {
    type: 'void', manageResize: false, shadows: false, lighting: { envMapEnabled: false },
  });
  assert.equal(handle.sceneType, 'void');
  assert.equal(handle.shadowPlane, null);
  assert.equal(handle.scene.environment, null);
  assert.equal(handle.renderer.shadowMap.enabled, false);
  assert.equal(callbacks.size, 0);
  handle.dispose();
  assertReleased(host, callbacks);
});

test('the synchronous API still immediately returns an attached, unprepared WebGL scene', (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const handle = createDefaultCharacterScene(host, { cameraFov: 50, type: 'showcase' });
  assert.equal(typeof handle.then, 'undefined');
  assert.equal(handle.renderer.compileCount, 0);
  assert.equal(handle.camera.fov, 50);
  assert.equal(handle.sceneType, 'showcase');
  assert.equal(handle.scene.background.getHex(), 0x101216);
  assert.equal(host.children.length, 1);
  assert.equal(callbacks.size, 1);
  assert.equal('backend' in handle, false);
  handle.dispose();
  handle.dispose();
  assertReleased(host, callbacks);
});

function webgpuAvailable(t, gpu = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  });
}

test('native WebGPU waits for init, uses its PMREM and reports its actual backend', async (t) => {
  webgpuAvailable(t);
  const callbacks = resizeEvents(t), host = container(), gate = deferred(), started = deferred();
  control.initialize = () => { started.resolve(); return gate.promise; };
  const pending = createDefaultCharacterSceneAsync(host, { renderer: 'webgpu' });
  await started.promise;
  assert.equal(control.pmrems.length, 0);
  assert.equal(host.children.length, 0);
  gate.resolve();
  const handle = await pending;
  assert.equal(handle.backend, 'webgpu');
  assert.equal(handle.renderer, control.gpuRenderers[0]);
  assert.equal(control.pmrems[0].backend, 'webgpu');
  assert.equal(handle.renderer.compileCount, 1);
  handle.dispose(); handle.dispose();
  assert.equal(handle.renderer.backend.disposeCount, 1);
  assertReleased(host, callbacks);
});

test('unavailable WebGPU fails explicitly before allocation; WebGL is still usable', async (t) => {
  webgpuAvailable(t);
  globalThis.navigator.gpu = undefined;
  const callbacks = resizeEvents(t), host = container();
  await assert.rejects(createDefaultCharacterSceneAsync(host, { renderer: 'webgpu' }), /WebGPU is unavailable/);
  assert.equal(control.renderers.length, 0);
  const handle = await createDefaultCharacterSceneAsync(host);
  assert.equal(handle.backend, 'webgl');
  handle.dispose(); assertReleased(host, callbacks);
});

test('Three WebGL2 fallback is rejected and both acquired backends are disposed', async (t) => {
  webgpuAvailable(t);
  const callbacks = resizeEvents(t), host = container();
  control.failure.fallback = true;
  await assert.rejects(createDefaultCharacterSceneAsync(host, { renderer: 'webgpu' }), /Native WebGPU initialization failed/);
  const renderer = control.gpuRenderers[0];
  assert.equal(renderer.backend.disposeCount, 1);
  assert.equal(renderer.initialBackend.disposeCount, 1);
  assert.equal(control.pmrems.length, 0);
  assertReleased(host, callbacks);
});

test('native init rejection frees its backend without unsafe renderer disposal', async (t) => {
  webgpuAvailable(t);
  const host = container();
  const failure = new Error('device request failed'); control.failure.init = failure;
  await assert.rejects(createDefaultCharacterSceneAsync(host, { renderer: 'webgpu' }), (error) => error === failure);
  const renderer = control.gpuRenderers[0];
  assert.equal(renderer.disposeCount, 0);
  assert.equal(renderer.backend.disposeCount, 1);
  assert.equal(host.children.length, 0);
});

test('abort during native init settles and releases the late renderer before PMREM', async (t) => {
  webgpuAvailable(t);
  const callbacks = resizeEvents(t), host = container(), gate = deferred(), started = deferred();
  const controller = new AbortController();
  control.initialize = () => { started.resolve(); return gate.promise; };
  const pending = createDefaultCharacterSceneAsync(host, { renderer: 'webgpu', signal: controller.signal });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await started.promise; controller.abort(); gate.resolve(); await rejection;
  assert.equal(control.pmrems.length, 0);
  assertReleased(host, callbacks);
});

for (const stage of ['environment', 'compile']) {
  test(`native ${stage} failure releases the renderer and all scene resources`, async (t) => {
    webgpuAvailable(t);
    const callbacks = resizeEvents(t), host = container(), failure = new Error(stage);
    control.failure[stage] = failure;
    await assert.rejects(createDefaultCharacterSceneAsync(host, { renderer: 'webgpu' }), (error) => error === failure);
    assertReleased(host, callbacks);
  });
}

for (const preference of ['webgpu', 'auto']) {
  test(`${preference} device loss during compilation rejects and never publishes a scene`, async (t) => {
    webgpuAvailable(t);
    const callbacks = resizeEvents(t), host = container();
    const losses = [];
    control.prepare = () => {
      control.gpuRenderers[0].onDeviceLost({ message: 'lost during compile' });
      return Promise.resolve();
    };
    await assert.rejects(createDefaultCharacterSceneAsync(host, {
      renderer: preference, onDeviceLost: (error) => losses.push(error),
    }), /lost during compile/);
    assert.equal(losses.length, 0);
    assert.equal(control.gpuRenderers[0].internalDeviceLosses.length, 1);
    assertReleased(host, callbacks);
  });
}

test('device loss preserves Three handling, stops the loop, and notifies once until disposal', async (t) => {
  webgpuAvailable(t);
  const callbacks = resizeEvents(t), host = container(), losses = [];
  const handle = await createDefaultCharacterSceneAsync(host, {
    renderer: 'webgpu', onDeviceLost: (error) => losses.push(error),
  });
  handle.renderer.onDeviceLost({ message: 'adapter reset' });
  handle.renderer.onDeviceLost({ message: 'duplicate' });
  assert.equal(handle.renderer.internalDeviceLosses.length, 2);
  await Promise.resolve();
  assert.deepEqual(handle.renderer.loopCallbacks, [null]);
  assert.equal(losses.length, 1);
  assert.match(losses[0].message, /adapter reset/);
  handle.dispose();
  handle.renderer.onDeviceLost({ message: 'late' });
  assert.equal(losses.length, 1);
  assertReleased(host, callbacks);
});

for (const reject of [false, true]) {
  test(`WebGPU abort waits for compilation ${reject ? 'rejection' : 'success'} and wins over its result`, async (t) => {
    webgpuAvailable(t);
    const callbacks = resizeEvents(t), host = container();
    const gate = deferred(), entered = deferred(), controller = new AbortController();
    control.prepare = () => { entered.resolve(); return gate.promise; };
    const pending = createDefaultCharacterSceneAsync(host, { renderer: 'webgpu', signal: controller.signal });
    await entered.promise;
    controller.abort();
    assert.equal(control.gpuRenderers[0].disposeCount, 0);
    assert.equal(host.children.length, 0);
    if (reject) gate.reject(new Error('compile failure after abort'));
    else gate.resolve();
    await assert.rejects(pending, { name: 'AbortError' });
    assertReleased(host, callbacks);
  });
}

test('default auto rejects an already aborted signal without probing or allocating', async (t) => {
  webgpuAvailable(t, { requestAdapter: () => { throw new Error('unexpected probe'); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createDefaultCharacterSceneAsync(container(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(control.renderers.length, 0);
});

for (const absentNavigator of [false, true]) {
  test(`auto uses WebGL when ${absentNavigator ? 'navigator is absent' : 'navigator.gpu is absent'}`, async (t) => {
    webgpuAvailable(t, null);
    if (absentNavigator) delete globalThis.navigator;
    const host = container(), callbacks = resizeEvents(t);
    const handle = await createDefaultCharacterSceneAsync(host);
    assert.equal(handle.backend, 'webgl');
    assert.equal(control.gpuRenderers.length, 0);
    assert.equal(control.renderers.length, 1);
    handle.dispose(); assertReleased(host, callbacks);
  });
}

for (const preference of [undefined, 'auto']) {
  test(`${preference ?? 'omitted'} preference selects native WebGPU with one actual initialization probe`, async (t) => {
    let adapters = 0, devices = 0;
    webgpuAvailable(t, { requestAdapter: async () => {
      adapters++;
      return { requestDevice: async () => { devices++; } };
    } });
    // Model Three's actual probe at its initialization boundary. The facade
    // must not request another adapter/device before calling renderer.init().
    control.initialize = async () => { const adapter = await navigator.gpu.requestAdapter(); await adapter.requestDevice(); };
    const host = container(), callbacks = resizeEvents(t);
    const handle = await createDefaultCharacterSceneAsync(host, { renderer: preference });
    assert.equal(handle.backend, 'webgpu');
    assert.equal(control.renderers.length, 1);
    assert.equal(handle.renderer.initCount, 1);
    assert.equal(adapters, 1); assert.equal(devices, 1);
    handle.dispose(); assertReleased(host, callbacks);
  });
}

test('explicit WebGL bypasses native initialization even when WebGPU is available', async (t) => {
  webgpuAvailable(t, { requestAdapter: () => { throw new Error('unexpected probe'); } });
  const host = container(), callbacks = resizeEvents(t);
  const handle = await createDefaultCharacterSceneAsync(host, { renderer: 'webgl' });
  assert.equal(handle.backend, 'webgl');
  assert.equal(control.gpuRenderers.length, 0);
  handle.dispose(); assertReleased(host, callbacks);
});

for (const failure of ['null adapter', 'init rejection']) {
  test(`auto releases ${failure} resources before constructing its WebGL fallback`, async (t) => {
    let adapters = 0;
    webgpuAvailable(t, { requestAdapter: async () => { adapters++; return null; } });
    control.initialize = async () => {
      if (failure === 'init rejection') throw new Error('requestDevice failed');
      assert.equal(await navigator.gpu.requestAdapter(), null);
      control.failure.fallback = true; // Three's own initialized WebGL2 fallback.
    };
    let checkedCleanup = false;
    control.rendererAcquired = () => {
      if (control.renderers.length !== 2) return;
      const native = control.gpuRenderers[0];
      assert.equal(native.initialBackend.disposeCount, 1);
      assert.equal(native.backend.disposeCount, 1);
      checkedCleanup = true;
    };
    const host = container(), callbacks = resizeEvents(t), losses = [];
    const handle = await createDefaultCharacterSceneAsync(host, { onDeviceLost: (error) => losses.push(error) });
    assert.equal(handle.backend, 'webgl');
    assert.equal(checkedCleanup, true);
    assert.equal(control.renderers.length, 2);
    assert.equal(control.pmrems.length, 1, 'failed native init never acquires a PMREM');
    assert.equal(adapters, failure === 'null adapter' ? 1 : 0);
    assert.equal(host.children.length, 1);
    assert.deepEqual(losses, []);
    // A late notification from the rejected attempt must not fail the fallback.
    control.gpuRenderers[0].onDeviceLost({ message: 'late native failure' });
    assert.deepEqual(losses, []);
    handle.dispose(); handle.dispose();
    assert.equal(handle.renderer.disposeCount, 1);
    assert.equal(host.children.length, 0);
    assert.equal(callbacks.size, 0);
    assert.equal(control.gpuRenderers[0].initialBackend.disposeCount, 1);
  });
}

for (const reject of [false, true]) {
  test(`auto cancellation during init never falls back after ${reject ? 'rejection' : 'success'}`, async (t) => {
    webgpuAvailable(t);
    const host = container(), callbacks = resizeEvents(t), gate = deferred(), started = deferred();
    const controller = new AbortController();
    control.initialize = () => { started.resolve(); return gate.promise; };
    const pending = createDefaultCharacterSceneAsync(host, { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started.promise;
    controller.abort();
    assert.equal(control.gpuRenderers[0].backend.disposeCount, 0);
    if (reject) gate.reject(new Error('failed after abort')); else gate.resolve();
    await rejected;
    assert.equal(control.renderers.length, 1);
    assert.equal(control.gpuRenderers[0].backend.disposeCount, 1);
    assert.equal(control.pmrems.length, 0);
    assert.equal(host.children.length, 0); assert.equal(callbacks.size, 0);
  });
}

test('auto preserves an initialization AbortError even without an aborted signal', async (t) => {
  webgpuAvailable(t);
  const failure = new DOMException('device initialization cancelled', 'AbortError');
  control.initialize = async () => { throw failure; };
  await assert.rejects(createDefaultCharacterSceneAsync(container()), (error) => error === failure);
  assert.equal(control.renderers.length, 1);
  assert.equal(control.gpuRenderers[0].backend.disposeCount, 1);
});

for (const preference of ['auto', 'webgpu']) {
  test(`${preference} device loss during initialization is handled without notifying the host`, async (t) => {
    webgpuAvailable(t);
    const host = container(), callbacks = resizeEvents(t), losses = [];
    control.initialize = async (renderer) => { renderer.onDeviceLost({ message: 'lost during init' }); };
    const pending = createDefaultCharacterSceneAsync(host, { renderer: preference, onDeviceLost: (error) => losses.push(error) });
    if (preference === 'webgpu') await assert.rejects(pending, /lost during init/);
    else {
      const handle = await pending;
      assert.equal(handle.backend, 'webgl');
      assert.equal(control.gpuRenderers[0].backend.disposeCount, 1);
      handle.dispose();
    }
    assert.deepEqual(losses, []);
    assert.equal(control.gpuRenderers[0].internalDeviceLosses.length, 1);
    assertReleased(host, callbacks);
  });
}

test('auto device loss after readiness reports the native failure without switching renderer', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t), losses = [];
  const handle = await createDefaultCharacterSceneAsync(host, { onDeviceLost: (error) => losses.push(error) });
  handle.renderer.onDeviceLost({ message: 'device reset after readiness' });
  assert.equal(handle.backend, 'webgpu');
  assert.equal(losses.length, 1);
  assert.match(losses[0].message, /device reset after readiness/);
  assert.equal(control.renderers.length, 1);
  assert.equal(handle.renderer.disposeCount, 0, 'returned ownership stays with the host');
  handle.dispose(); assertReleased(host, callbacks);
});

for (const stage of ['environment', 'compile']) {
  test(`auto preserves a post-initialization ${stage} error without falling back`, async (t) => {
    webgpuAvailable(t);
    const host = container(), callbacks = resizeEvents(t), failure = new Error(stage);
    control.failure[stage] = failure;
    await assert.rejects(createDefaultCharacterSceneAsync(host), (error) => error === failure);
    assert.equal(control.renderers.length, 1);
    assertReleased(host, callbacks);
  });
}

test('runtime initial failure retains scene and lighting for a controller-owned retry', async (t) => {
  webgpuAvailable(t, null);
  const callbacks = resizeEvents(t), host = container();
  const runtime = createDefaultCharacterSceneRuntime(host, { rendering: { preference: 'webgpu' } });
  const { scene, camera, lighting, shadowPlane } = runtime;
  const observations = [];
  const unsubscribe = runtime.rendering.subscribe((snapshot) => observations.push(snapshot));
  await assert.rejects(runtime.ready, /WebGPU is unavailable/);
  assert.equal(runtime.rendering.getSnapshot().status, 'error');
  assert.equal(runtime.renderer, null);
  lighting.setSettings({ exposure: 1.4 });
  await runtime.rendering.setSettings({ preference: 'webgl' });
  assert.equal(runtime.scene, scene); assert.equal(runtime.camera, camera);
  assert.equal(runtime.lighting, lighting); assert.equal(runtime.shadowPlane, shadowPlane);
  assert.equal(runtime.renderer.toneMappingExposure, 1.4);
  assert.equal(runtime.backend, 'webgl');
  assert.equal(observations.at(-1).status, 'ready');
  unsubscribe(); await runtime.dispose(); assertReleased(host, callbacks);
});

test('live renderer selection retains scene, character, camera, lights and authored settings', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t);
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' });
  await runtime.ready;
  const { scene, camera, lighting, shadowPlane } = runtime;
  const lights = scene.children.slice();
  // A character is caller-owned. Cloning the tracked scene would also copy its
  // environment and register that borrowed clone as another owned scene.
  const model = new Group(); model.name = 'borrowed-character'; scene.add(model);
  camera.position.set(2, 3, 4); lighting.setSettings({ exposure: 1.3, keyIntensity: .8 });
  const oldRenderer = runtime.renderer, oldEnvironment = lighting.getEnvironmentTexture();
  await runtime.rendering.setSettings({ preference: 'webgpu' });
  assert.equal(runtime.scene, scene); assert.equal(runtime.camera, camera);
  assert.equal(runtime.lighting, lighting); assert.equal(runtime.shadowPlane, shadowPlane);
  assert.deepEqual(scene.children.slice(0, lights.length), lights);
  assert.equal(model.parent, scene); assert.deepEqual(camera.position.toArray(), [2, 3, 4]);
  assert.equal(runtime.backend, 'webgpu'); assert.equal(runtime.renderer.toneMappingExposure, 1.3);
  assert.notEqual(lighting.getEnvironmentTexture(), oldEnvironment);
  assert.equal(oldRenderer.disposeCount, 1); assert.equal(host.children.length, 1);
  assert.equal(runtime.renderer.renderCount, 1, 'prepare current scene on the candidate before publication');
  scene.remove(model); await runtime.dispose(); assertReleased(host, callbacks);
});

test('failed compilation or canvas attachment keeps the previous working renderer', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t);
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' }); await runtime.ready;
  const renderer = runtime.renderer, environment = runtime.lighting.getEnvironmentTexture();
  const failure = new Error('candidate compile'); control.failure.compile = failure;
  await assert.rejects(runtime.rendering.setSettings({ preference: 'webgpu' }), (error) => error === failure);
  assert.equal(runtime.renderer, renderer); assert.equal(renderer.disposeCount, 0);
  assert.equal(runtime.scene.environment, environment); assert.deepEqual(host.children, [renderer.domElement]);
  assert.equal(runtime.rendering.getSnapshot().status, 'error');
  const lease = runtime.rendering.acquireRenderer(); assert.equal(lease.renderer, renderer); lease.release();
  delete control.failure.compile;
  const append = host.appendChild;
  host.appendChild = function (child) { append.call(this, child); throw failure; };
  await assert.rejects(runtime.rendering.setSettings({ preference: 'webgpu' }), (error) => error === failure);
  assert.equal(runtime.renderer, renderer); assert.equal(runtime.scene.environment, environment);
  assert.deepEqual(host.children, [renderer.domElement]);
  host.appendChild = append; await runtime.dispose(); assertReleased(host, callbacks);
});

test('latest renderer request wins and the superseded candidate is released after compile', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t), entered = deferred(), compile = deferred();
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' }); await runtime.ready;
  const oldRenderer = runtime.renderer;
  control.prepare = () => { entered.resolve(); return compile.promise; };
  const first = runtime.rendering.setSettings({ preference: 'webgpu' });
  const canceled = assert.rejects(first, { name: 'AbortError' });
  await entered.promise;
  const candidate = control.gpuRenderers[0];
  const second = runtime.rendering.setSettings({ preference: 'webgl' });
  assert.equal(candidate.disposeCount, 0); assert.equal(runtime.renderer, oldRenderer);
  control.prepare = undefined; compile.resolve();
  await canceled; await second;
  assert.equal(candidate.disposeCount, 1); assert.equal(runtime.backend, 'webgl');
  assert.equal(runtime.rendering.getSettings().preference, 'webgl');
  assert.equal(host.children.length, 1); await runtime.dispose(); assertReleased(host, callbacks);
});

test('capture leases delay replacement and equal preference joins the pending request', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t);
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' }); await runtime.ready;
  const lease = runtime.rendering.acquireRenderer(), renderer = lease.renderer;
  const switching = runtime.rendering.setSettings({ preference: 'webgpu' });
  assert.equal(runtime.rendering.setSettings(runtime.rendering.getSettings()), switching);
  assert.throws(() => runtime.rendering.acquireRenderer(), /not available/);
  assert.equal(renderer.disposeCount, 0); assert.equal(runtime.scene.environment, runtime.lighting.getEnvironmentTexture());
  lease.release(); lease.release(); await switching;
  assert.equal(renderer.disposeCount, 1); await runtime.dispose(); assertReleased(host, callbacks);
});

test('dispose closes immediately and settles after compilation and capture borrowing', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t), entered = deferred(), compile = deferred();
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' }); await runtime.ready;
  control.prepare = () => { entered.resolve(); return compile.promise; };
  const switching = runtime.rendering.setSettings({ preference: 'webgpu' });
  const canceled = assert.rejects(switching, { name: 'AbortError' });
  await entered.promise;
  const done = runtime.dispose(); assert.equal(runtime.dispose(), done);
  assert.equal(runtime.rendering.getSnapshot().status, 'disposed');
  assert.equal(control.gpuRenderers[0].disposeCount, 0);
  assert.throws(() => runtime.lighting.setSettings({ exposure: 1 }), /disposed/);
  compile.resolve(); await canceled; await done; assertReleased(host, callbacks);

  control.prepare = undefined;
  const next = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' }); await next.ready;
  const lease = next.rendering.acquireRenderer();
  let disposed = false; const disposal = next.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false); assert.equal(lease.renderer.disposeCount, 0);
  lease.release(); await disposal; assert.equal(lease.renderer.disposeCount, 1);
});

test('lighting edits during switching prepare their current revision and keep one controller', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t), entered = deferred(), compile = deferred();
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' }); await runtime.ready;
  const lighting = runtime.lighting;
  control.prepare = () => { entered.resolve(); return compile.promise; };
  const switching = runtime.rendering.setSettings({ preference: 'webgpu' }); await entered.promise;
  lighting.setSettings({ exposure: 1.7, environmentBlur: .01 });
  control.prepare = undefined; compile.resolve(); await switching;
  assert.equal(runtime.lighting, lighting); assert.equal(runtime.renderer.toneMappingExposure, 1.7);
  assert.equal(runtime.renderer.compileCount, 2);
  await runtime.dispose(); assertReleased(host, callbacks);
});

test('device-loss snapshot permits WebGL recovery without rebuilding character state', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t);
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgpu' }); await runtime.ready;
  const { scene, lighting, camera } = runtime;
  runtime.renderer.onDeviceLost({ message: 'device reset' });
  assert.equal(runtime.rendering.getSnapshot().status, 'lost');
  assert.throws(() => runtime.rendering.acquireRenderer(), /not available/);
  await runtime.rendering.setSettings({ preference: 'webgl' });
  assert.equal(runtime.rendering.getSnapshot().status, 'ready'); assert.equal(runtime.backend, 'webgl');
  assert.equal(runtime.scene, scene); assert.equal(runtime.lighting, lighting); assert.equal(runtime.camera, camera);
  await runtime.dispose(); assertReleased(host, callbacks);
});

test('subscriber retry after synchronous construction failure is retained as the latest request', async (t) => {
  const host = container(), callbacks = resizeEvents(t);
  control.failure.constructor = new Error('first constructor failure');
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' });
  let retry;
  runtime.rendering.subscribe((snapshot) => {
    if (snapshot.status !== 'error' || retry) return;
    delete control.failure.constructor;
    retry = runtime.rendering.setSettings({ preference: 'webgl' });
  });
  await assert.rejects(runtime.ready, /first constructor failure/);
  await retry;
  assert.equal(runtime.rendering.getSnapshot().status, 'ready');
  assert.equal(runtime.backend, 'webgl'); assert.equal(host.children.length, 1);
  await runtime.dispose(); assertReleased(host, callbacks);
});

test('WebGPU to WebGL prepares the main and shadow cameras with WebGL depth projections', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t);
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgpu' });
  await runtime.ready;
  runtime.renderer.render(runtime.scene, runtime.camera);
  const cameras = [runtime.camera, runtime.scene.getObjectByName('embodyCharacterKeyLight').shadow.camera];
  const expected = cameras.map(camera => {
    assert.equal(camera.coordinateSystem, WebGPUCoordinateSystem);
    const copy = camera.clone(); copy.coordinateSystem = WebGLCoordinateSystem; copy.updateProjectionMatrix();
    return copy.projectionMatrix.elements;
  });
  control.prepare = () => {
    cameras.forEach((camera, index) => {
      assert.equal(camera.coordinateSystem, WebGLCoordinateSystem);
      assert.deepEqual(camera.projectionMatrix.elements, expected[index]);
    });
  };
  await runtime.rendering.setSettings({ preference: 'webgl' });
  cameras.forEach((camera, index) => assert.deepEqual(camera.projectionMatrix.elements, expected[index]));
  await runtime.dispose(); assertReleased(host, callbacks);
});

for (const initial of ['webgl', 'webgpu']) {
  test(`failed replacement restores ${initial} main and shadow projections`, async (t) => {
    webgpuAvailable(t);
    const host = container(), callbacks = resizeEvents(t);
    const runtime = createDefaultCharacterSceneRuntime(host, { renderer: initial }); await runtime.ready;
    runtime.renderer.render(runtime.scene, runtime.camera);
    const original = runtime.renderer;
    const cameras = [runtime.camera, runtime.scene.getObjectByName('embodyCharacterKeyLight').shadow.camera];
    const saved = cameras.map(camera => ({ coordinates: camera.coordinateSystem, matrix: [...camera.projectionMatrix.elements] }));
    const append = host.appendChild;
    host.appendChild = function (canvas) { append.call(this, canvas); throw new Error('candidate attachment failed'); };
    await assert.rejects(runtime.rendering.setSettings({ preference: initial === 'webgl' ? 'webgpu' : 'webgl' }), /attachment failed/);
    assert.equal(runtime.renderer, original);
    cameras.forEach((camera, index) => {
      assert.equal(camera.coordinateSystem, saved[index].coordinates);
      assert.deepEqual(camera.projectionMatrix.elements, saved[index].matrix);
    });
    host.appendChild = append;
    await runtime.dispose(); assertReleased(host, callbacks);
  });
}

test('lost-renderer cleanup drains captures and precedes a queued recovery', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t);
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgpu' }); await runtime.ready;
  const model = new Group(), unrelated = new Group(); runtime.scene.add(model, unrelated);
  const lease = runtime.rendering.acquireRenderer();
  runtime.renderer.onDeviceLost({ message: 'device reset' });
  let released = 0;
  const cleanup = runtime.rendering.releaseSceneResources(() => { runtime.scene.remove(model); released++; });
  await Promise.resolve();
  assert.equal(released, 0);
  assert.throws(() => runtime.rendering.acquireRenderer(), /not available/);
  control.prepare = () => { assert.equal(released, 1); assert.equal(model.parent, null); };
  const recovery = runtime.rendering.setSettings({ preference: 'webgl' });
  lease.release();
  await cleanup; await recovery;
  assert.equal(released, 1); assert.equal(unrelated.parent, runtime.scene);
  runtime.scene.remove(unrelated);
  await runtime.dispose(); assertReleased(host, callbacks);
});

test('resource cleanup still runs after a failed pending renderer switch', async (t) => {
  webgpuAvailable(t);
  const host = container(), callbacks = resizeEvents(t), compile = deferred(), entered = deferred();
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' }); await runtime.ready;
  control.prepare = () => { entered.resolve(); return compile.promise; };
  const switching = runtime.rendering.setSettings({ preference: 'webgpu' });
  const switchFailure = assert.rejects(switching, /compile failed/);
  await entered.promise;
  let released = false;
  const cleanup = runtime.rendering.releaseSceneResources(() => { released = true; });
  assert.equal(released, false);
  assert.equal(runtime.rendering.setSettings({ preference: 'webgpu' }), switching, 'joining a switch must retain its failure even when cleanup is queued');
  compile.reject(new Error('compile failed'));
  await switchFailure; await cleanup;
  assert.equal(released, true); assert.equal(runtime.backend, 'webgl');
  const lease = runtime.rendering.acquireRenderer(); lease.release();
  await runtime.dispose(); assertReleased(host, callbacks);
});

test('resource cleanup after scene disposal waits its borrowers even when owned cleanup fails', async (t) => {
  const host = container(), callbacks = resizeEvents(t);
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' }); await runtime.ready;
  const lease = runtime.rendering.acquireRenderer();
  control.failure.dispose = new Error('renderer disposal failed');
  const disposal = assert.rejects(runtime.dispose(), /renderer disposal failed/);
  let released = 0;
  const cleanup = runtime.rendering.releaseSceneResources(() => { released++; });
  await Promise.resolve(); assert.equal(released, 0);
  lease.release(); await disposal; await cleanup;
  assert.equal(released, 1); assert.equal(runtime.rendering.getSnapshot().status, 'disposed');
  assertReleased(host, callbacks);
});

test('a failing release callback rejects without blocking later renderer acquisition', async (t) => {
  const host = container(), callbacks = resizeEvents(t);
  const runtime = createDefaultCharacterSceneRuntime(host, { renderer: 'webgl' }); await runtime.ready;
  await assert.rejects(runtime.rendering.releaseSceneResources(() => { throw new Error('model disposal failed'); }), /model disposal failed/);
  const lease = runtime.rendering.acquireRenderer(); lease.release();
  await runtime.dispose(); assertReleased(host, callbacks);
});
