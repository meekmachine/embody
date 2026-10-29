# Default scene readiness and renderer selection

## Character host ownership

`createCharacterHost` composes the existing model loader, scene, camera controller,
Embody engine and native render integration. Applications resolve database profiles
and authorized asset URLs; they do not construct another scene, model binding or
render loop around this host. The returned `cameraController`, lighting and rendering
controllers expose editor operations. `gltf` retains model metadata for attribution.

`character.profile` and `embody.profileMode` retain their existing semantics. An
already-expanded profile uses `profileMode: 'profile'`; the host does not silently
select a preset. The existing Rust mapping validator applies supported model-name
corrections to that runtime copy and the supplied `character.annotationConfig`.
Saved annotation configuration controls initial regions and camera behavior; the
full-body fallback applies only when no annotation configuration was supplied.

`loadModel(url, { ...loaderOptions, signal })` can deliver the model through the
application's existing authenticated cache or storage route. Resolving transfers
the model and its resources to the host, including late results after cancellation.
The host releases rejected/superseded results after any borrowed Three work settles.
The default loader remains available and cannot interrupt a Three parse already in
progress. Applications retain database authorization and profile persistence.

`prepareCharacter({ engine, model, meshes, animations, gltf, character, signal })`
runs with a bound, stopped engine so authored morph edits can use its public APIs.
Saved transforms precede binding and reference capture. The model remains hidden.
Embody then normalizes morph layouts, reinspects authored targets, prepares GPU
resources, applies camera configuration,
and reveals the model. `onCharacterReady` runs after preparation and camera setup,
before reveal. These callbacks borrow the host's rendering lease; they must not
await a renderer switch or host disposal that needs that lease. Optional embedded
clips remain available on `host.animations` when `registerEmbeddedAnimations: false`;
this prevents eager registration without discarding their source data. No saved
animation autoplay policy is introduced. Profile-enabled hair continues through
Embody's existing native clip path.

The factory's `signal` covers construction only and is detached after success.
`setCharacter(character, loaderOptions?, signal?)` preserves the scene while replacing
the engine/model. Newer requests cancel older ones; cancellation is checked after
asset delivery, authored preparation and GPU preparation before publication. A
failed preparation retains the previous character. A retirement failure after
publication reports an error while the host still identifies the new character.
`dispose()` cancels outstanding
work, drains renderer borrowers and releases the final model and owned scene.

`character.scene` contains `CharacterSceneConfiguration`: scene type, background,
camera FOV, shadows, lighting preset/settings and shadow-plane visibility. Every
character applies a fresh configuration through the existing scene handle's
`setSceneSettings` method. Omitted values reset to the selected scene type's defaults
instead of retaining another character's edits. Renderer preference and DOM/resize
ownership remain factory settings. Backend replacement preserves the current
character's shadow and lighting choices.

Acceptance in the application should cover loading a saved custom profile, authored
morph replay, saved annotation focus, manual animation controls, enabled hair,
switching to a character with different or absent scene settings, cancelling a
switch during loading/preparation, and disposing while a renderer operation is
pending. CI owns execution of the host lifecycle, morph-layout and scene-setting
regressions; these checks are not evidence of completed browser acceptance.

## Scenery layouts and background ownership

`createSceneSceneryRenderer({ scene, rendering, loadAsset, onError })` attaches
scenery to an existing scene. `loadAsset(assetId, signal)` returns
`{ bytes: ArrayBuffer, contentType: string }` through the application's authorized
asset path. Storage, catalog identities, persisted layouts and selection precedence
remain application concerns. Polymer may reexport this Three adapter; applications
do not need direct GLTF loaders, texture loaders or a second render loop.

`update(layout)` accepts `SceneSceneryLayout | null`. A layout contains `skybox`
and `instances`. Each instance has a unique `instanceId`, an `assetId` and finite
world `position: { x, y, z }` in the scene's native units (Y up in default scenes).
A placement wrapper preserves the GLB's authored transforms. Two instances of one
asset remain independent. Editing a retained placement's position does not reload
it. Changing its asset or removing it cancels its download/parse completion and
retires only that placement. Models must be self-contained GLB 2.0 with content
type `model/gltf-binary`; parsing refuses external texture/geometry URLs.
Embedded animation clips are not played automatically.

The optional background contains `kind: 'skybox' | 'backdrop' | 'color'`,
`assetId: string | null`, six-digit `color: '#rrggbb'`, finite nonnegative
`intensity`, and finite `rotation` in Y-axis degrees. Skybox images use
equirectangular mapping; backdrops use screen-space mapping. PNG, JPEG and WebP
images load through the same asset callback. A missing image asset creates a
gradient using the saved color. A solid color requires `assetId: null`.
All layout fields validate and copy before any selection changes. Runtime load
errors reach `onError`; a failed image replacement keeps the previous committed
background, and the same update can retry it. Superseded work never attaches.

Each scene permits one live scenery controller. Default scene constructors and
`setSceneSettings` keep the character's inherited background separate from the
scenery override. Character replacement can update that base under an active
skybox; clearing scenery restores the latest base, including its intensity and
rotation. Applications must not mutate `scene.background` while scenery owns it.
Scenery leaves the character, camera, native render loop, lighting/environment
and unrelated scene objects intact.

Pass the existing scene's `rendering` controller so model attachment, background
swaps and resource retirement use `releaseSceneResources` to drain compilation,
captures and native frames. Omit it only when the external scene owner guarantees
there is no borrowed asynchronous rendering work. `dispose()` cancels loads,
releases logical background ownership immediately and returns the same promise
until pending noninterruptible parses/decodes and resource cleanup settle. A new
controller may acquire the scene while that cleanup drains; the retired owner
cannot overwrite the new background. Await disposal before releasing externally
owned scene resources. Disposing an Embody-owned default scene also cancels its
scenery owner. An authorized loader must honor cancellation or eventually settle.

Character preparation acquires its renderer through
`rendering.acquireRendererAsync()`. Admission waits queued scenery cleanup or
renderer replacement, then holds a lease before its promise resolves. A scenery
download completing during a character change therefore queues behind an
already admitted character or completes before its admission; it does not turn
ordinary resource contention into a failed character load. Cancellation after
admission releases that lease before the candidate model is retired. The
synchronous `acquireRenderer()` remains available for immediate capture and
continues to reject while scene resource work is queued. Async admission rejects
when the owner is disposed or its active renderer is lost, while a failed switch
that retained a healthy renderer still permits borrowing it. Callers release
either kind of lease in `finally`; they must not request async admission while
holding a lease that queued scene work is waiting to drain.

```ts
import { createSceneSceneryRenderer } from '@lovelace_lol/embody/three';

const scenery = createSceneSceneryRenderer({
  scene: host.scene,
  rendering: host.rendering,
  loadAsset: loadAuthorizedSceneryBytes,
  onError: showSceneryError,
});
scenery.update({
  skybox: { kind: 'skybox', assetId: 'garden-sky', color: '#668cae', intensity: 1, rotation: 90 },
  instances: [{ instanceId: 'tree-left', assetId: 'tree', position: { x: -2, y: 0, z: 4 } }],
});
// Later: await scenery.dispose(), then release an externally owned scene.
```

CI regression source covers invalid/duplicate placements, independent instances,
late loader/parse/decode results, latest-base restoration, overlapping controller
cleanup and renderer-drained disposal. These adapter cases do not establish
browser acceptance or saved selection behavior in the application.

## Renderer selection

The Three adapter owns renderer acquisition, switching, lighting/environment,
canvas binding and backend recovery. Hosts persist settings and display the
controller snapshot. Character loading and animation scheduling stay with their
existing owners. The default preference is `auto`; the synchronous legacy
factory remains WebGL-only.

```ts
import { createDefaultCharacterSceneRuntime, ThreeAnnotationController } from '@lovelace_lol/embody/three';

const runtime = createDefaultCharacterSceneRuntime(container, {
  rendering: { preference: 'auto' },
});
const cameraControls = await ThreeAnnotationController.create({
  scene: runtime.scene, camera: runtime.camera, domElement: container,
  rendering: runtime.rendering,
});
const unsubscribe = runtime.rendering.subscribe(renderSnapshot);
// A failed initial attempt leaves this controller available for recovery.
void runtime.ready.catch(() => {}); // Error/status are also in the snapshot.
await runtime.rendering.setSettings({ preference: 'webgl' });
// No scene, character, camera, lighting controller or agency recreation.
unsubscribe();
await runtime.dispose(); // Drains compilation, frames and outstanding leases.
cameraControls.dispose();
// Caller-owned model/overlay resources may now be disposed.
```

`CharacterSceneRenderingController` follows the lighting-controller pattern:
`getSettings()`, async `setSettings(patch)`, and `subscribe(listener)`. The
subscription immediately emits `getSnapshot()`: requested settings, actual
`backend` and `renderer`, status (`initializing`, `switching`, `ready`, `error`,
`lost`, `disposed`), and an `Error | null`. Backend/renderer are null before the
first successful attempt. Requested preferences are `auto | webgl | webgpu`;
actual backends are only `webgl | webgpu`. Snapshots are atomic pairs; scene
handle getters follow the current renderer. Retain a renderer only with a lease.
Subscriber exceptions are reported without interrupting publication or cleanup.

A replacement initializes offscreen, drains current borrowed operations, pauses
the existing camera loop, and prepares the current scene and its model before
committing the new canvas, controls and environment. Scene, camera, model,
lights, lighting controller and marker state retain identity. Lighting edits
received during compilation are prepared before publication. A failed switch
keeps the previous renderer and environment when they remain healthy. Status
`error` can therefore include a usable previous backend; `lost` cannot be used
for new rendering work. A newer preference supersedes pending work with
`AbortError`, after started Three work settles. Repeating the same pending
preference joins its promise. Selecting the same preference after an error/loss
retries it. Auto fallback applies only to native acquisition/initialization;
material, preparation, attachment and loop-binding failures are visible errors.

`createDefaultCharacterSceneAsync` remains the compatibility factory: it awaits
initial success and rejects after cleanup on failure. Successful handles also
expose `rendering`; their backend/renderer getters stay non-null. Its async
`dispose()` must now be awaited before freeing borrowed character resources.
`createDefaultCharacterScene` remains synchronous WebGL, with synchronous
`dispose()`. `rendering.preference` takes precedence over the legacy `renderer`
option when supplied. No host renderer-switch hook or page reload is required.

## Borrowing renderer and character resources

`rendering.acquireRenderer()` returns `{ renderer, release }`. Release in a
`finally` block after asynchronous readback, recording or a character-resource
mutation finishes. New leases are rejected while switching, lost or disposed.
A switch waits existing leases before touching the current environment or
renderer; disposal waits them before releasing owned resources. Release is
idempotent. Never await a switch while holding a lease it needs to drain.

For character replacement, first join any current switch with
`setSettings(getSettings())`, then acquire a lease around model/preview loading,
attachment, readiness and cleanup. Call `cameraControls.clearModel()` before
disposing a removed model, including when a replacement load fails. Catch a failed switch only if its snapshot
still has a healthy previous renderer; acquisition enforces that condition.
If another request wins before acquisition, cancel/retry that model operation.
A pending switch waits this lease while the old loop remains available for model
readiness; the camera controller does not take a nested lease. Release on success
and on cancellation/failure. Likewise, marker/material mutations while switching
must be performed under a lease. Hosts do not schedule renderer replacement.

On teardown, cancel resource users and release their leases, then await
`runtime.dispose()` before disposing the camera controller, models or overlays.
It closes immediately and returns the same completion on repeated calls. The
completion drains in-flight compilation, frame callbacks and captures; Three
operations that never settle have no timeout guarantee. Calling the camera's
`dispose()` first also defers its owned marker release until the scene operation
settles, but does not grant permission to free borrowed models early.

To remove caller-owned resources while keeping a borrowed scene, use
`await rendering.releaseSceneResources(() => { /* detach and dispose */ })`.
The callback is synchronous: clear any matching camera-controller model reference,
detach the model, and free its resources inside it. Embody serializes this operation
with renderer replacement, drains captures and camera work, then resumes a healthy
renderer. New capture leases are unavailable until cleanup finishes. This operation
also works with a lost renderer or after scene disposal; it never requests recovery.
After disposal it waits for owned cleanup to settle, even if that cleanup rejects.
A callback failure rejects its own completion. Do not call it while holding a lease
that it needs to drain, or await renderer operations inside the callback.

## Readiness and resource ownership

Both async paths await `compileAsync(scene, camera)` before attaching the canvas
and resize listener. WebGPU first dynamically imports `three/webgpu`, awaits
`renderer.init()`, verifies a native WebGPU backend, and creates its environment
with the WebGPU PMREM generator. The WebGL path uses the WebGL PMREM generator.
The default lights, shadow plane, tone mapping and scene settings are shared.
WebGL selects `PCFShadowMap` directly, matching Three's current soft-shadow
fallback without emitting its `PCFSoftShadowMap` deprecation warning. Native
WebGPU retains its existing filter; shadow selection does not reload the character.
The size is refreshed after preparation in case the container changed meanwhile.

Before preparing a replacement, Embody sets the main and shadow cameras to that
backend's coordinate system and updates their projection matrices. Failed
replacement restores their preceding coordinate systems before resuming the old
renderer. This matters when returning from WebGPU's depth range to WebGL.

Embody also prepares skinned meshes' joint indices as `Float32BufferAttribute`
before renderer compilation. Three's native backend widens integer joint buffers
to `Uint32Array` in place; WebGL binds those as integer shader inputs even though
its skinning shader expects `vec4`, preventing the character from drawing after a
switch. Float32 represents every glTF joint index exactly and works with both
backends. `setModel` and model render preparation perform this conversion before
the first draw, including interleaved indices and hidden skinned meshes. Geometry,
skin weights, skeletons, animation and model identity remain intact. A failed
renderer replacement restores any joint attributes it converted for that attempt
before resuming the preceding renderer's cached pipeline.

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
  effect; no abort listener is retained. `dispose()` is idempotent and its completion releases
  lighting, PMREM targets, shadow plane, renderer and owned DOM/listener entries.
  Caller-added models require separate disposal. `resize()` after disposal is a
  no-op; disposed lighting cannot reacquire resources.
- Readiness covers the initial scene only. It does not imply future character
  materials, textures, first visible frame or application state are prepared.
  PMREM generation remains synchronous after initialization. Parallel shader
  compilation availability varies; this is not a performance guarantee.

## Device loss and camera rendering

Native loss preserves Three's internal loss handler and stops the affected loop.
Loss during initialization follows the strict/auto selection policy; loss during
candidate preparation rejects that candidate. Unpublished or disposed attempts
do not notify the compatibility `onDeviceLost` callback. Loss after readiness
publishes `lost` with the error; `setSettings` can acquire a healthy renderer
without recreating the scene. Recovery is explicit, never a hidden backend swap.

Pass `rendering` to `ThreeAnnotationController` to bind it to the runtime. Its one
loop is suspended/drained, then retargeted along with native input controls and annotation
canvas listeners by Embody. Pending model readiness is canceled before switching.
Bound render/loop failures update the rendering snapshot rather than invoking a
fatal host `onRenderError` recovery path. The legacy fixed-renderer configuration
still invokes `onRenderError`. Asynchronous frame callbacks remain serialized.
The factory itself does not install a second animation loop. Neither controller
owns or disposes caller-added character resources.

## Model readiness

`ThreeAnnotationController.prepareModelForRender(model, { signal? }): Promise<void>`
prepares a loaded model before its first reveal. The controller must own an
active renderer loop, and a WebGPU renderer must already be initialized (as it
is after `createDefaultCharacterSceneAsync`). The model must be detached or part
of the controller scene with visible ancestors. Passing the scene itself is an
error. The model's root may be hidden during loading: preparation temporarily
exposes that root, preserves authored hidden children and layers, and disables
culling for its visible objects. Before the preparation draw, it initializes
missing culling spheres from the current world/skin/morph pose. Otherwise,
unculling would defer Three's lazy skinned-vertex scan to the first visible
frame. Existing authored spheres are retained; hidden objects and objects with
culling disabled are left alone. These cached bounds describe the prepared pose,
not every future animation pose; callers retain Three's responsibility to
refresh bounds when needed after deformation. Temporary attachment and state changes are
restored synchronously before any await.

```ts
controller.setModel(model);
await controller.prepareRegionsAndMarkersForReveal(profile, async () => {
  await controller.prepareModelForRender(model, { signal: request.signal });
  return !request.signal.aborted;
});
// The host still owns reveal and animation start.
scene.add(model);
```

The adapter calls `compileAsync(model, camera, scene)` so only the model's
surface resources are retained by asynchronous compilation. It then performs
one full-scene, zero-viewport draw at the beginning of the controller's existing
frame. This initializes visible textures/geometry and real shadow variants,
including complete static shadow maps, on both WebGL and native WebGPU. The
normal `renderFrame` callback is skipped for that single preparation frame; it
resumes on the next frame. There is no additional animation loop, per-object
queue, WebGL shadow proxy or GPU-completion fence. Legacy region-loading APIs
do not invoke model readiness automatically. Do not await readiness from inside
the controller's `renderFrame` callback: readiness itself needs a future frame.

A new preparation supersedes the previous one. `setModel`, clearing/replacing
region state, signal abort and controller disposal cancel pending preparation
with `AbortError`. A queued draw cancels without requiring another frame, even
in a hidden tab. Already-started Three compilation cannot be interrupted:
rejection waits for it to settle, with cancellation taking precedence over its
failure. A failed controller render loop also rejects pending preparation.
Ordinary compilation or preparation-draw failures reject the readiness promise
and preserve the original cause; the host chooses recovery or retry.

The controller never disposes the supplied model, scene, environment, lights or
renderer. The caller must keep those borrowed resources alive and must not
change the model's geometry/materials until the promise settles, including after
abort or controller disposal. Dispose the controller to cancel its queued work,
then await readiness settlement before disposing borrowed resources. Marker
objects are excluded from asynchronous model compilation, so controller-owned
marker replacement and disposal retain their existing behavior.

Readiness covers currently visible model surfaces and receiving/shadow variants
under the current scene settings. Authored hidden children, camera-excluded
layers, later marker styles, material changes and new lights can require later
compilation. The preparation draw is indivisible and can still take a long
frame; readiness neither guarantees a frame-time budget nor confirms GPU
completion or presentation. Renderer/scene state is restored after errors;
failed or unrefreshed shadow maps remain dirty for the next eligible draw.

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
scene objects. They cover acquisition, cancellation, auto fallback/strict rejection,
live replacement, resource leases and disposal ordering. Execution of the new
cases is delegated to CI; they do not establish hardware rendering or visual parity. The host
integration for [LoomLarge #957](https://github.com/meekmachine/LoomLarge/issues/957)
still needs matched browser checks of character materials, transparency/hair,
shadows, annotations/overlays, background and capture on supported hardware.
Warmup and capture must use backend-specific APIs. Measure initialization, model
preparation, first visible frame and steady rendering separately.
