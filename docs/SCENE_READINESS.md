# Default scene readiness

The Three adapter owns renderer creation, default lighting/environment and the
shadow plane. Hosts own model loading, animation scheduling and first reveal.
`createDefaultCharacterSceneAsync` gives hosts an explicit readiness boundary
without changing the existing synchronous WebGL factory.

```ts
import { createDefaultCharacterSceneAsync } from '@lovelace_lol/embody/three';

const request = new AbortController();
const handle = await createDefaultCharacterSceneAsync(container, {
  type: 'studio', signal: request.signal,
});
// The initial scene is prepared, and its canvas is now attached.
// Add and prepare the character separately before revealing it.
handle.renderer.render(handle.scene, handle.camera);
// Release when the host is finished, including after a later loading failure.
handle.dispose();
```

The resolved `ReadyDefaultCharacterScene` has the existing scene handles and
`backend: 'webgl'`. It uses `WebGLRenderer`, with no second renderer or animation
loop. `DefaultCharacterSceneAsyncOptions` adds `signal?: AbortSignal` to the
typed scene settings. The synchronous factory still returns immediately and
does not call `compileAsync`.

## Readiness and resource ownership

The async path creates the renderer, environment, lights and optional shadow
plane, then awaits `WebGLRenderer.compileAsync(scene, camera)`. Only after this
succeeds does it recheck cancellation, update the size, append the canvas and
register its resize listener. It does not reveal a character or prepare objects
added later. PMREM generation itself remains synchronous. Shader compilation
may also block when parallel compilation is unavailable; this API is not a
performance claim or a guarantee that all GPU work has completed.

- An already aborted signal rejects with a DOM `AbortError` before allocation.
- Three exposes no way to interrupt `compileAsync`. During preparation, abort
  prevents attachment but waits for compilation to settle before disposal and
  rejection. There is no timeout guarantee if Three's preparation never settles.
  Disposing while Three is polling program readiness would invalidate that work.
- If abort and a preparation failure occur together, cancellation wins. Without
  cancellation, the original setup/preparation error is rethrown unchanged.
- Failure attempts cleanup of every successfully acquired resource, even if
  another disposer throws. Cleanup errors do not mask a setup error.
- The signal has no effect after successful resolution. The caller owns the
  returned scene and must dispose it on unmount, switching or subsequent failure.
  No abort listener or background animation loop is installed by this factory.
- `dispose()` is idempotent. It releases lighting, PMREM targets, shadow plane,
  renderer, and owned DOM/listener attachments. `resize()` after disposal does
  nothing. Updating/subscribing to disposed lighting throws to prevent resource
  reacquisition. Models added by the caller still need their own disposal.

The async API requires a Three version providing `WebGLRenderer.compileAsync`;
missing support fails clearly and rolls back. The checked dependency is r170.
The broad existing peer range is unchanged for synchronous consumers.
[r170's implementation](https://github.com/mrdoob/three.js/blob/r170/src/renderers/WebGLRenderer.js)
waits for prepared material programs and uses `KHR_parallel_shader_compile`
when available. Lifecycle tests replace only the renderer/PMREM boundary and
exercise real Three scene objects; they do not establish hardware correctness.

## Next slice: opt-in WebGPU

This is the Embody foundation for
[LoomLarge #957](https://github.com/meekmachine/LoomLarge/issues/957), not its
WebGPU renderer delivery. Polymer needs to await this API when it owns a scene
and compose abort/rollback with its loaded model and engine. LoomLarge then
needs to retain its stale-request and reveal checks around that asynchronous
host lifecycle. Existing synchronous consumers remain supported.

Before adding WebGPU, choose and test one Three version/import graph across
Embody, Polymer, the app, loaders and type declarations. Version-pinned probes
against installed r170 and r184 found:

| Import comparison | r170 | r184 |
| --- | --- | --- |
| `three` / `three/webgpu` Object3D, Mesh, Color, ShadowMaterial identities | Different constructors | Same constructors |
| Plain Node import of `three/webgpu` | Throws because `self` is undefined | Succeeds |
| PMREMGenerator identity | Different | Different |

The build source explains the core identity change: r170's
[WebGPU bundle](https://github.com/mrdoob/three.js/blob/r170/build/three.webgpu.js)
includes its own core, while r184's
[WebGPU bundle](https://github.com/mrdoob/three.js/blob/r184/build/three.webgpu.js)
imports shared `three.core.js`. A coordinated version update should precede
the WebGPU renderer path; r184 is a tested candidate here, not an adopted
minimum or proof of application compatibility. Keep browser renderer creation
out of Node/SSR imports.

The next renderer implementation also needs these explicit contracts:

- Await `WebGPURenderer.init()` before environment creation and use its
  [backend-compatible PMREMGenerator](https://github.com/mrdoob/three.js/blob/r184/src/renderers/common/extras/PMREMGenerator.js).
  In r184, calling `fromScene` before initialization starts deferred work;
  calling it after initialization generates the environment synchronously.
  The WebGL PMREM generator is not an interchangeable constructor.
- Report the actual initialized backend. WebGPURenderer can fall back to its
  WebGL2 backend, which differs from the existing WebGLRenderer. Neither its
  class name nor `navigator.gpu` establishes native WebGPU rendering.
- Audit materials, shadows, transparency/hair, overlays, background and capture
  with real character assets. r184's
  [standard node library](https://github.com/mrdoob/three.js/blob/r184/src/renderers/webgpu/nodes/StandardNodeLibrary.js)
  maps standard/physical/shadow materials, lights and tone mapping. Custom GLSL
  ShaderMaterial/RawShaderMaterial and `onBeforeCompile` still need a port to
  node materials/TSL, per the
  [version-pinned migration guide](https://github.com/mrdoob/three.js/blob/r184/manual/en/webgpurenderer.html).
  Do not cast a WebGPU renderer to the current WebGL-specific host types or
  assume existing texture/framebuffer warmup and capture helpers apply.
- Define device loss as an explicit lifecycle event before exposing WebGPU.
  r184's default
  [device-loss callback](https://github.com/mrdoob/three.js/blob/r184/src/renderers/common/Renderer.js)
  logs and marks the renderer lost; it does not rebuild it. Any wrapper must
  preserve that internal behavior and deliberately dispose/recreate through
  the owning host, rather than promising automatic recovery.

Retain WebGL as the default until opt-in native WebGPU and its WebGL2 fallback
pass matched visual/lifecycle checks. Measure real hardware initialization,
model preparation, first visible frame and steady rendering separately.
