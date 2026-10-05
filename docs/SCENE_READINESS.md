# Default scene readiness and renderer selection

The Three adapter owns renderer creation, lighting/environment and the shadow
plane. Hosts own character loading, animation scheduling, first reveal and
recovery. The async factory defaults to automatic native WebGPU selection with
WebGL fallback when native initialization fails. The synchronous factory stays
WebGL-only.

```ts
import { createDefaultCharacterSceneAsync } from '@lovelace_lol/embody/three';

const request = new AbortController();
const handle = await createDefaultCharacterSceneAsync(container, {
  type: 'studio',
  renderer: 'auto', // Default. Use 'webgl' or 'webgpu' for an explicit choice.
  signal: request.signal,
  onDeviceLost: (error) => showRendererRecovery(error.message),
});
// The initial scene is prepared and attached. Prepare later models separately.
if (handle.backend === 'webgpu') {
  // handle.renderer is WebGPURenderer here, not WebGLRenderer.
}
handle.renderer.render(handle.scene, handle.camera);
handle.dispose();
```

`CharacterSceneRenderer` is `WebGLRenderer | WebGPURenderer` and
`CharacterSceneBackend` is `'webgl' | 'webgpu'`. The requested
`CharacterSceneRendererPreference` also accepts `'auto'`; that preference is
never returned as an actual backend. `ReadyDefaultCharacterScene`
discriminates the renderer by its actual `backend`. The synchronous
`createDefaultCharacterScene` remains WebGL-specific and returns immediately
without shader preparation; it does not accept renderer selection.

## Readiness and resource ownership

Both async paths await `compileAsync(scene, camera)` before attaching the canvas
and resize listener. WebGPU first dynamically imports `three/webgpu`, awaits
`renderer.init()`, verifies a native WebGPU backend, and creates its environment
with the WebGPU PMREM generator. The WebGL path uses the WebGL PMREM generator.
The default lights, shadow plane, tone mapping and scene settings are shared.
The size is refreshed after preparation in case the container changed meanwhile.

Auto uses WebGL if the API is unavailable or native acquisition fails, including
module loading, renderer construction, initialization or device loss during
initialization. If Three initializes its own WebGL2 fallback, Embody disposes
that attempt and creates its WebGL scene with the WebGL PMREM path. Every acquired
resource from the failed attempt is released before creating the fallback.
Native `renderer.init()` performs the adapter/device probe; Embody does not
request an extra adapter or device. `navigator.gpu` alone is not evidence of
successful native initialization.

Explicit `renderer: 'webgpu'` rejects those failures instead of falling back.
Explicit `renderer: 'webgl'` skips the native attempt entirely. After native
initialization succeeds, scene setup, compilation and attachment failures remain
errors, including device loss during compilation. Auto does not hide those
failures by constructing a different scene. No preference falls back on
cancellation. Hosts can offer an explicit WebGL retry after an error.

- An already aborted signal rejects with `AbortError` before allocation.
- Three's initialization and compilation cannot be interrupted. Cancellation
  prevents attachment, but waits for pending work to settle before disposal and
  rejection. There is no timeout guarantee if that work never settles.
- If abort and preparation failure occur together, cancellation wins. Otherwise
  the original setup/preparation error is rethrown after rollback.
- Failure attempts all acquired-resource cleanup even if another disposer throws.
  Cleanup errors do not mask the setup failure.
- After resolution, the caller owns the scene. Later signal cancellation has no
  effect; no abort listener is retained. `dispose()` is idempotent and releases
  lighting, PMREM targets, shadow plane, renderer and owned DOM/listener entries.
  Caller-added models require separate disposal. `resize()` after disposal is a
  no-op; disposed lighting cannot reacquire resources.
- Readiness covers the initial scene only. It does not imply future character
  materials, textures, first visible frame or application state are prepared.
  PMREM generation remains synchronous after initialization. Parallel shader
  compilation availability varies; this is not a performance guarantee.

## Device loss and camera rendering

On native device loss, Embody preserves Three's internal loss handler and stops
its animation loop. Loss during initialization makes auto fall back, while an
explicit WebGPU request rejects. Loss during later scene preparation rejects
and rolls back for either preference. Neither case notifies the host callback
for a scene that was never returned. After readiness, `onDeviceLost(Error)`
reports the first loss, including its message;
no backend/device object is exposed by that callback. The host must stop its
work, dispose the scene and offer recovery/recreation. There is no automatic
fallback or renderer rebuild after readiness. Late loss notifications after
disposal, including those from a failed auto attempt, are ignored.
Do not replace `renderer.onDeviceLost`: use the factory option to preserve this
behavior.

`DPthreeCameraController` accepts `CharacterSceneRenderer`. Its optional
`renderFrame` callback can return `void` or `Promise<void>`; another frame is
skipped until a pending callback settles. A thrown/rejected frame or loop-start
failure stops rendering and invokes `onRenderError(Error)` (or logs without a
handler). Rejections after controller disposal are consumed without notifying a
stale host. The controller does not own or dispose the supplied renderer.
The factory does not install a host render loop; keep one owner for scheduling.

## Three version and remaining browser acceptance

The package requires Three >= 0.184.0 and tests exact runtime/types 0.184.0.
Consumers must align their Three runtime, loaders and declarations. Version-pinned
probes found distinct core constructors between `three` and `three/webgpu` at
r170; r184 shares `three.core.js` and plain Node import succeeds. Embody's GPU
runtime import stays dynamic so explicit WebGL/SSR import does not initialize a
browser renderer. PMREM constructors remain backend-specific.

Source references for this choice:

- [r184 WebGPU bundle](https://github.com/mrdoob/three.js/blob/r184/build/three.webgpu.js)
  shares the core module, unlike the
  [r170 bundle](https://github.com/mrdoob/three.js/blob/r170/build/three.webgpu.js).
- [WebGPURenderer](https://github.com/mrdoob/three.js/blob/r184/src/renderers/webgpu/WebGPURenderer.js)
  can initialize a WebGL2 fallback, so Embody checks its initialized backend.
- [Common PMREMGenerator](https://github.com/mrdoob/three.js/blob/r184/src/renderers/common/extras/PMREMGenerator.js)
  performs synchronous environment generation only after renderer initialization.
- [StandardNodeLibrary](https://github.com/mrdoob/three.js/blob/r184/src/renderers/webgpu/nodes/StandardNodeLibrary.js)
  maps standard/physical/shadow materials, lights and tone mapping. The
  [migration guide](https://github.com/mrdoob/three.js/blob/r184/manual/en/webgpurenderer.html)
  requires custom GLSL ShaderMaterial/RawShaderMaterial and `onBeforeCompile`
  changes to be ported to node materials/TSL.
- [WebGPUBackend](https://github.com/mrdoob/three.js/blob/r184/src/renderers/webgpu/WebGPUBackend.js)
  supplies loss information; the
  [common renderer](https://github.com/mrdoob/three.js/blob/r184/src/renderers/common/Renderer.js)
  marks itself lost but does not rebuild automatically.

Lifecycle tests mock the renderer/PMREM boundary while retaining real Three
scene objects. They establish acquisition, cancellation, auto fallback/strict rejection,
error and disposal ordering, not hardware rendering or visual parity. The host
integration for [LoomLarge #957](https://github.com/meekmachine/LoomLarge/issues/957)
still needs matched browser checks of character materials, transparency/hair,
shadows, annotations/overlays, background and capture on supported hardware.
Warmup and capture must use backend-specific APIs. Measure initialization, model
preparation, first visible frame and steady rendering separately.
