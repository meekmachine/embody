import assert from 'node:assert/strict';
import { register } from 'node:module';
import test, { beforeEach } from 'node:test';

const entry = new URL(process.env.EMBODY_SCENE_SOURCE === '1' ? '../../three/scene.ts' : '../../dist/three.js', import.meta.url);
const fixture = new URL('../fixtures/character-scene/three.mjs', import.meta.url);
register('../fixtures/character-scene/loader.mjs', import.meta.url, { data: { entry: entry.href, fixture: fixture.href } });
const { control } = await import(fixture.href);
const { createDefaultCharacterScene, createDefaultCharacterSceneAsync } = await import(entry.href);

beforeEach(() => control.reset());

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
  const pending = createDefaultCharacterSceneAsync(host).then((value) => { settled = true; return value; });
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
  await assert.rejects(createDefaultCharacterSceneAsync(host, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(control.renderers.length, 0);
  assertReleased(host, callbacks);
});

test('abort during compilation waits for settlement, then rolls back without attaching', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const gate = deferred();
  const controller = new AbortController();
  control.prepare = () => gate.promise;
  const pending = createDefaultCharacterSceneAsync(host, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
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
  const handle = await createDefaultCharacterSceneAsync(host, { signal: controller.signal });
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
    await assert.rejects(createDefaultCharacterSceneAsync(host), (error) => error === failure);
    assertReleased(host, callbacks);
  });
}

test('async compilation rejection preserves the original error even when disposal fails', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const failure = new Error('preparation rejected');
  control.prepare = () => Promise.reject(failure);
  control.failure.dispose = new Error('cleanup failed');
  await assert.rejects(createDefaultCharacterSceneAsync(host), (error) => error === failure);
  assertReleased(host, callbacks);
});

test('cancellation wins over a simultaneous preparation rejection after rollback', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const gate = deferred();
  const controller = new AbortController();
  control.prepare = () => gate.promise;
  const pending = createDefaultCharacterSceneAsync(host, { signal: controller.signal });
  const failure = new Error('compile failed');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  gate.reject(failure);
  await rejected;
  assertReleased(host, callbacks);
});

test('older renderers without compileAsync fail clearly and release the scene', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  control.failure.missingCompileAsync = true;
  await assert.rejects(createDefaultCharacterSceneAsync(host), /require Three.js WebGLRenderer.compileAsync/);
  assertReleased(host, callbacks);
});

test('normal disposal continues after a resource throws and cannot reacquire lighting', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const handle = await createDefaultCharacterSceneAsync(host);
  const failure = new Error('material disposal failed');
  handle.shadowPlane.material.addEventListener('dispose', () => { throw failure; });
  assert.throws(() => handle.dispose(), (error) => error === failure);
  assert.doesNotThrow(() => handle.dispose());
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
  await assert.rejects(createDefaultCharacterSceneAsync(host), (error) => error === failure);
  assertReleased(host, callbacks);
});

test('disabled resize management and the void scene retain their settings', async (t) => {
  const callbacks = resizeEvents(t);
  const host = container();
  const handle = await createDefaultCharacterSceneAsync(host, {
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

function webgpuAvailable(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: {} } });
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

test('device loss before readiness rejects and never publishes a scene', async (t) => {
  webgpuAvailable(t);
  const callbacks = resizeEvents(t), host = container();
  const losses = [];
  control.prepare = () => {
    control.gpuRenderers[0].onDeviceLost({ message: 'lost during compile' });
    return Promise.resolve();
  };
  await assert.rejects(createDefaultCharacterSceneAsync(host, {
    renderer: 'webgpu', onDeviceLost: (error) => losses.push(error),
  }), /lost during compile/);
  assert.equal(losses.length, 0);
  assert.equal(control.gpuRenderers[0].internalDeviceLosses.length, 1);
  assertReleased(host, callbacks);
});

test('device loss preserves Three handling, stops the loop, and notifies once until disposal', async (t) => {
  webgpuAvailable(t);
  const callbacks = resizeEvents(t), host = container(), losses = [];
  const handle = await createDefaultCharacterSceneAsync(host, {
    renderer: 'webgpu', onDeviceLost: (error) => losses.push(error),
  });
  handle.renderer.onDeviceLost({ message: 'adapter reset' });
  handle.renderer.onDeviceLost({ message: 'duplicate' });
  assert.equal(handle.renderer.internalDeviceLosses.length, 2);
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
