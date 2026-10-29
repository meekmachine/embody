# Embody

Explicit profiles may be empty: `RuntimeCore.configure_with_profile('{}', modelJson)`
loads a static or not-yet-mapped model without selecting an embedded preset.
Missing mappings remain an authoring/validation concern; malformed JSON still
fails configuration. Existing mapped profiles retain their runtime behavior.

Embody is a Rust/Wasm character animation core for facial action units,
visemes, bone controls, baked animation clips, and hair motion. Three.js is a
host adapter, not the runtime implementation.

## Reading historical saved movements

`decodeLegacyPose(record, historicalProfile?)` and
`decodeLegacyAnimation(record, historicalProfile?)` translate retired named
`semanticPose` / `semanticAnimation` records into existing numeric AU fields.
The translation and conflict checks live in Rust. Await `initEmbodyCore()` before
decoding historical records; ordinary records without the retired field return
unchanged and do not require initialization. Inputs are JSON saved records.

Explicit `historicalProfile.bodyControls` metadata is authoritative, including an
empty map. Only when that metadata is absent does the decoder use the embedded
historical table. Unresolved names, conflicting authored values, and opposing
pose directions fail without changing the input. Keyframe seconds, balance,
morph strength, custom profile IDs, and unrelated saved metadata are preserved.
The returned copy removes the decoded retired field; this does not write storage.

These readers do not consolidate eye mappings, assign FACS/body namespaces,
convert curve snippets into explicit channels, or change native playback. Those
migrations require profile-specific equivalence and compiler parity work under
[Polymer epic #325](https://github.com/meekmachine/Polymer/issues/325). Semantic
readback and slider ownership remain separate integration work.

## Architecture

```text
src/                 Rust source (the Wasm crate) — hair, clips, profiles, runtime
assets/presets/      Embedded typed character profiles
assets/templates/    Embedded humanoid skeleton templates
three/               Thin Three.js inspection/application adapter only
model-tools/         Browser/Node GLB preparation, public types, and CLI
wasm/                Generated-Wasm JS loader + ABI constants
index.ts             Package re-exports only
```

There is no parallel TypeScript hair/physics/runtime core. Hair idle, impulse,
gravity curves and the spring solver live in `src/hair_curves.rs` /
`src/hair.rs` and are exported through Wasm. Hosts schedule the resulting
ClipIR on their mixer; they must not reimplement hair sampling in TS.

The Rust core owns:

- preset and profile parsing, typed merge rules, validation, and corrections
- AU, viseme, morph, bone, continuum, and live control state
- compiling AU/viseme/named-morph snippets into concrete ClipIR
  (`morphTarget` / `boneTransform` tracks) for the host mixer to schedule
- mesh-category routing and material profile data
- hair curves, hair physics, and appearance normalization
- annotation regions, camera gestures/flights/orbits, marker placement and visibility,
  preview/reveal lifecycles, and humanoid template fitting
- on-demand semantic AU reads of active AU-curve clips (no clock or polling)
- renderer-neutral model analysis and packed live frame generation
- transient mesh highlight selection, styling, transitions, and versioned preview snapshots

`resolveMorphMeshSelections(profile, categories, availableNames)` resolves editor
mesh selections in one Rust request. It returns each requested category's effective
category, `hasSelection` (including explicit empty arrays), resolved loaded names,
and unresolved configured names. Request `viseme` for speech routing. Facial
categories share an authored `face` selection; body and hair stay independent.
Exact names take precedence over legacy mesh aliases. Consumers save concrete
resolved names plus unresolved names when editing, so deselecting one mesh does
not reactivate it through a legacy alias. This query does not change the profile.

`getAUBoneBindingStates(profile, auIds)` resolves a panel's AU bone links in one
Rust request and returns an object keyed by AU ID. It uses the existing
`getAUBoneBindingState` semantics, including custom bone names, axis/range,
continuum opposites and explicitly cleared bindings. Its profile input contains
only `auToBones`, `boneNodes`, `bonePrefix`, `boneSuffix`, `suffixPattern`,
`compositeRotations`, `continuumPairs` and `humanoidCharacterization`.
The adapter omits unrelated morph/mesh configuration, authored vertices and saved
clips before serialization. Mesh selection edits do not invalidate these bone
links; hosts can cache by those bone inputs and the requested AU IDs. This is a
read-only authoring query, with no rig replacement or playback effects.

The host animation library (Three `AnimationMixer`, Unity Animator, etc.) owns
clip playback, lerping, blending, looping, seeking, and crossfades. Rust must
not sample or lerp clips on the hot path.

`Embody` is the character API exposed by the native Three adapter.
`createRustEmbodyHost`, `createRustEmbodyHostUnbound` and
`createCharacterHost(...).engine` use that same class. Its profile, mesh,
material, hair and clip-catalog result types come from `three/authoringTypes.ts`;
downstream libraries can re-export them without another character interface.
`getProfile()` returns `Partial<Profile>` because an explicit profile may be
empty, and `getHairPhysicsConfig()` may be empty before the first model bind.
`ProfileInput` accepts sparse mappings and app metadata without adding arbitrary
keys to the output `Profile` declaration. Humanoid queries accept sparse profiles;
`setHumanoidRoleBinding` returns a sparse profile because Rust omits empty tables.
The bone editor queries and mutation results follow the same sparse data contract.
`setAUMorphTargets` preserves its input JSON and guarantees the edited `auToMorphs`
map. An omitted serialized field is not a request to delete an authored override.
These type declarations add no playback state, lifecycle or animation clock.

An AU animation drives its profile's mapped bones and morphs through the same
Rust evaluation used by live AU controls. For example, speech can send an AU
103 curve and separate viseme shape curves; the profile decides which bones
and morphs AU 103 moves. Hosts must not replace that AU with a hardcoded jaw
rotation or read `auToBones` to construct their own bone tracks. When LipSync
already supplies a jaw AU curve, its existing `autoVisemeJaw: false` option
keeps automatic viseme jaw synthesis from replacing that curve; it does not
disable the AU's mapped morphs or the viseme shapes.

The TypeScript adapter is intentionally limited to operations that require
Three.js objects: scene traversal, ClipIR ↔ `AnimationClip` conversion, frame
application, material writes, model loading/disposal, and default scene
construction. Annotation adapters capture DOM input, observe native geometry,
apply Rust camera/marker frames, render labels and release native resources.
Camera integration, region selection and marker state belong to Rust.

`createSceneSceneryRenderer` from `@lovelace_lol/embody/three` applies resolved
scenery layouts to the existing scene: self-contained GLB placements with independent
world XYZ positions, equirectangular skyboxes, image backdrops and solid colors.
Applications supply an abortable authorized byte loader and retain saved layouts,
asset catalogs and Persona/Character/Interaction selection policy. The adapter
owns model/texture loading, stale-result cancellation and renderer-drained cleanup;
it preserves the character, lights and existing render loop. Character scene
settings remain the inherited background beneath scenery, so clearing an override
restores the latest character configuration. See the
[scenery contract](docs/SCENE_READINESS.md#scenery-layouts-and-background-ownership).

`ThreeFrameApplier.applyMeshMaterialConfigs(model, profile.meshes)` replays named
mesh visibility and material overrides when a host binds or replaces a profile.
It applies explicit `visible: false` and `visible: true` even without a material
entry, and restores render order, opacity, transparency, depth flags and blending
from `material`. Omitted fields leave the model's current values unchanged.
Replaying identical material values during a mapping edit leaves the material
version unchanged; render-order-only edits also avoid invalidating material programs.
Polymer calls this adapter during model binding and profile replacement; hosts
do not need a separate mesh-visibility replay loop.

`MorphVertexPreview` owns the editor's affected-vertex overlay and updates from
the existing Three scene render callback. It reuses position/color frame arrays,
retains samples only for the active hover, and releases old GPU attributes before
replacing differently sized geometry. Hiding or changing the hover clears its
sample cache; an explicitly empty mesh selection produces no preview. Applications
forward hover/show/hide events and dispose the overlay when its scene is released.

### Preparing Actor Models

`@lovelace_lol/embody/model-tools` exposes `inspectActorModel(bytes)` and
`prepareActorModel(bytes, options)` to prepare separate GLB files for an Actor.
This module owns file transformations; LoomLarge owns the guided workflow,
Model upload, Actor persistence, and Mapping selection. It does not load the
animation runtime or initialize Embody's runtime Wasm.

```js
import { inspectActorModel, prepareActorModel } from '@lovelace_lol/embody/model-tools';

const source = new Uint8Array(await file.arrayBuffer());
const inspection = await inspectActorModel(source);
// Show inspection.meshes to the creator before choosing explicit mesh IDs.
const prepared = await prepareActorModel(source, {
  kind: 'low-resolution',
  targetRatio: 0.5,
  maxError: 0.001,
  signal: abortController.signal,
});
// Persist prepared.bytes as a new Model only after the operation succeeds.
```

Inspection returns source-scoped mesh IDs, original names, node names,
materials, vertex/triangle counts, skin and morph presence, total byte length,
and processing limitations. Preparation returns a new byte array, before/after
inspection, the removed source mesh IDs, and warnings. It never writes into the
input array, fetches resources, or persists an Actor.

| Kind | File operation |
| --- | --- |
| `original` | Copy source bytes exactly. |
| `optimized` | Compact unused vertex data and remove explicitly selected meshes and orphaned file resources. |
| `low-resolution` | Reduce triangle count; default target is 50%, limited by geometry, rig protection, and error. |
| `miniature` | Apply an explicitly supplied uniform `scale` above existing scene roots. This changes physical scale, not texture resolution. |
| `bust` | Keep explicit `keepMeshIds`; requires separately authored body-part meshes. |
| `outfit` | Keep/remove explicit mesh IDs for a prepared outfit; never guess garments from names. |

`targetRatio` accepts 0.05–1 and `maxError` accepts 0–0.05 relative to each
primitive's extent. `scale` is required only for miniature and accepts 0.01–0.99.
Mesh IDs belong to the inspected input; inspect each new file before editing it
again. Removing a shared mesh removes all its instances. A combined body mesh
must be split in a modeling tool before a bust or garment can be removed. These
tools do not generate clothing, transfer garments between rigs, cut surfaces,
or implement runtime garment switching.

Processed variants require self-contained, extension-free GLB. Unsupported
extensions (including compression and VRM) or resource URIs produce an explicit
error before rewriting. Original copies retain such payloads and inspection
reports `canTransform: false`; hosts must still apply their upload policy.
Textures keep their original bytes and dimensions. Output includes actual byte
and triangle counts; a requested reduction is not a size guarantee.

Triangle reduction locks vertices participating in any morph and vertices at
skin-influence transitions. It preserves topological borders and weighs normals,
UVs, and colors. All retained attributes, including joints, weights and every
morph target, use one vertex remap. Existing mesh/node names, skeleton hierarchy,
bind matrices and surviving animation targets remain intact. Only morph animation
channels targeting an explicitly removed mesh are removed, with a warning.
No node, joint, or surviving morph target is renamed. Hosts must review Mapping
targets when source names are missing/duplicated or a mapped mesh was removed;
vertex-index annotations require remapping after compaction.

Cancellation is checked between processing stages and primitives. A synchronous
simplifier call cannot be interrupted halfway through; hosts should use a worker
when processing large assets must not occupy the UI thread.

The installed `embody-prepare-actor` command uses the same implementation:

```bash
embody-prepare-actor --input character.glb --inspect
embody-prepare-actor --input character.glb --output low.glb --kind low-resolution --ratio 0.5
embody-prepare-actor --input character.glb --output outfit.glb --kind outfit --remove-mesh mesh:2
embody-prepare-actor --input character.glb --output bust.glb --kind bust --keep-mesh mesh:0
```

Repeat `--remove-mesh`/`--keep-mesh` for multiple selections. The CLI refuses an
existing output path, including the source file or a symlink to it. It prints a
JSON report after creating the new file. In a source checkout, invoke
`node model-tools/prepare-actor.mjs` with the same arguments. CI runs the
`test:model-tools` regression source as part of the existing package checks.

### Annotation runtime

`AnnotationRuntime` in `src/annotation_runtime/` owns the annotation behavior
and mutable state in Rust/Wasm: camera input and damping, framing and intro
transitions, authored/runtime regions, AU/bone target selection, laterality,
anchors, surface-query planning, expansion, solo, styles, visibility and layout.
`AnnotationLifecycle` owns preview/reveal deadlines and the effects they emit.
There is no TypeScript annotation state machine or OrbitControls dependency.

`ThreeAnnotationController` and the `ThreeAnnotations` convenience facade from
`@lovelace_lol/embody/three` provide native adapters. `ThreeAnnotationMarkers`,
`HtmlAnnotationMarkers`, and its `OverlayAnnotationMarkers` alias provide
marker-only views of the same Rust runtime. Their TypeScript code captures input,
serializes model observations, calls native raycasts and skinned-vertex evaluation,
applies packed Rust frames, creates labels, and owns renderer resources. Three
continues to own scene objects and GPU operations; those APIs cannot be replaced
by renderer-neutral Rust. Both marker styles share the same state and selection
rules. HTML occlusion uses Rust-planned rays evaluated by Three.

Rust fits marker endpoints before marker loading returns and on each update,
including additions, endpoint separation and reveal overshoot. Clipping uses
the displayed label dimensions and preserves the minimum leader-line length;
temporary overshoot clipping does not restart the reveal. Sphere sizing retains
the close-up scale and clamped distance scaling outside that range. Explicit
`markerAnchor.projectToSurface: false` also applies to `objects: ['*']` anchors.
HTML overlays align with the canvas rectangle inside its container, update on
resize/rebind, and restore borrowed parent positioning when the final view is
disposed. These coordinates assume axis-aligned CSS boxes without transforms.

AU morph anchors follow morph and skeletal animation on each annotation update.
Rust selects and caches affected vertices and their influence weights during
marker preparation, using mesh-space geometry so rotating a character cannot
change the selected semantic band. The adapter evaluates those vertices in the
current native pose and supplies packed world-space positions; Rust updates the
existing anchors without restarting reveal or rebuilding marker resources.
Explicit point and whole-model anchors retain their existing behavior. Model or
region changes invalidate the plans, and stale or invalid pose observations are
ignored. Geometry is immutable within a plan: after replacing topology or morph
attributes, rebind the model or reload regions to select vertices again.

This is a breaking replacement of the DPthree exports. Use
`ThreeAnnotationController.create(options)` or `ThreeAnnotations.create(options)`
to await Wasm initialization; synchronous constructors require an already initialized
core. Replace DPthree-prefixed types with `AnnotationCharacterConfig`,
`AnnotationRegion`, `AnnotationRegistry`, and the corresponding callback types.
The `controls` bridge retains `target`, `enabled`, damping/distance settings,
`update()`, and `change`/`start`/`end` listeners, but is not a Three `OrbitControls`
instance. Region and camera snapshots are observations; mutate through controller
methods. Explicit `undefined` fields in `updateAnnotationRegion` remove overrides.
`getCharacterConfig()` retains snapshot identity until configuration content or
the model changes; selection, visibility and camera input do not replace it.
Authored intro focus targets use the same framing as manual region selection;
extra eye padding and composition bias apply only to the default region target.
Call `clearModel()` before releasing a removed model's native resources. The
controller retains renderer rebinding, canvas input reconnect and resource-drain
support through the scene's rendering controller.
Runtime preview region IDs retain the `runtime:annotation:` namespace.

When the annotation controller owns the renderer loop, it advances registered
native character mixers before observing annotation poses and drawing the
scene. The first frame establishes the timer origin; skipped asynchronous draws
do not accumulate playback time. External render loops use the existing
`createScenePlaybackFrame` integration to advance character playback, then call
`annotations.update()` before drawing. No per-frame application-side anchor
logic or agency registration is required.

```ts
import { ThreeAnnotations } from '@lovelace_lol/embody/three';

const annotations = await ThreeAnnotations.create({ scene, camera, domElement: canvas });
annotations.setModel(model);
await annotations.loadCharacter({ characterId: 'character', profilePresetId: 'cc4' });
// Host-owned render loop: call annotations.update() before renderer.render(...).
```

Applications pass `AnnotationCharacterConfig`; storage, agency, editor and
character-asset metadata remain host concerns. `loadRegions` defaults to
`resolveAnnotationCharacterConfig`, which resolves annotation and AU mapping
fields from an Embody preset without serializing unrelated host metadata.
An optional `resolveCharacterConfig` callback supports host profile intake.
`prepareRegionsForReveal` defers native marker construction until the first
`setMarkersVisible(true)` call. Later visibility changes reuse those resources;
Rust's loaded state resets when the model or configuration is replaced.
`prepareRegionsAndMarkersForReveal` accepts an already-resolved profile and
prepares native surface queries while the model pose is still stable.
Initial queries yield to a browser paint between meshes once a 4 ms slice is
spent. Each native mesh raycast is indivisible; slicing does not reduce total
raycast CPU time. Interactive edits retain synchronous queries so a marker samples
one pose. Rust generations reject stale profile, surface and reveal completions
after replacement, clearing, region edits or disposal. Camera requests settle when
completed or cancelled, including controller disposal.

The direct Wasm boundary uses JSON commands/snapshots for configuration and
primitive model observations with stable object IDs. Frames, vertex candidates,
transform observations and ray results use packed typed arrays; coordinates are
world-space, camera/visibility angles are degrees, durations are milliseconds,
and viewport dimensions are CSS pixels. The layouts and operations are maintained
in [the Rust runtime](src/annotation_runtime/mod.rs) and
[marker frames](src/annotation_runtime/markers.rs); generated Wasm declarations
remain the ABI type source. IDs are scoped to one model lifetime.

For first reveal, call `controller.prepareModelForRender(model, { signal })`
from the existing `beforeReveal` callback (or directly before attaching the
model). It compiles the model's visible surfaces, then uses the controller's
existing render loop for one complete scene preparation draw. No host warmup
queue, shadow proxies or texture preparation loop is needed. The promise rejects
on failure or cancellation; retain borrowed model/scene/renderer resources until
it settles, even after `controller.dispose()`. This prepares visible variants,
not every future hidden material or animation state. See the
[model readiness contract](docs/SCENE_READINESS.md#model-readiness).

`createMarkerVisibilityLifecycle` and `createRuntimeAnnotationPreviewLifecycle`
transport host events to `AnnotationLifecycle`; browser timers only wake Rust at
its next deadline. Factories can queue input while Wasm initializes; `ready`
reports the current initialization attempt. After an initialization failure,
the next command retries or adopts a core initialized by another scene. Failed
attempts discard their queued input. `dispose()` also discards pending input,
cancels timers and frees the runtime, so cleanup before readiness cannot replay
callbacks. Later calls create a fresh runtime, preserving host effect-replay cleanup.
React hosts forward user events and subscribe to controller state. They do not
need local copies of the camera, marker, placement or timer algorithms.
The convenience facade delegates to one controller-owned marker layer.

## Character model loading

The Three adapter loads GLB/glTF and FBX characters into the same
`{ model, meshes, animations, gltf }` result. `meshes` contains morph-enabled
meshes; FBX results have `gltf: null`. Both formats use the same shadow setup,
model transforms, inspection, and disposal helpers.

```ts
import { loadCharacterModel, parseCharacterModel } from '@lovelace_lol/embody/three';

const character = await loadCharacterModel('/characters/avatar.fbx');
// For blob URLs or endpoints without a file extension, supply the format.
const uploaded = await loadCharacterModel(objectUrl, { format: 'fbx' });
// Standard binary/ASCII FBX headers are detected automatically. The resource path resolves
// external textures referenced by the file.
const cached = await parseCharacterModel(buffer, '/characters/textures/');
```

Use `format: 'gltf'` or `format: 'fbx'` to override detection. Draco options apply
to glTF only. FBX rigs, morph names, scale, and external texture paths depend on
the export; use a matching character profile and model transform as needed.
Loading a format does not automatically retarget its rig or rename its morphs.

## Runtime Use

Embody is an ES module package. Use `import` / dynamic `import()`; CommonJS
`require()` is not a supported runtime API. Package subpaths remain resolvable
through Node for tooling that only needs to locate an exported file.

Initialize the Wasm module before constructing a runtime:

```ts
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import {
  AnimationMixer,
} from 'three';
import {
  ThreeFrameApplier,
  ThreeModelInspector,
  createAnimationClipFromClipIR,
} from '@lovelace_lol/embody/three';

const wasm = await initEmbodyCore();
const inspector = new ThreeModelInspector();
const applier = new ThreeFrameApplier();
const inspection = inspector.inspectModel(model, { profile });
const runtime = new wasm.RuntimeCore(0);
const mixer = new AnimationMixer(model);

applier.setBindings(inspection);
runtime.configure_with_preset(
  'cc4',
  JSON.stringify(profileOverrides ?? {}),
  JSON.stringify(inspection.descriptor),
);

const clipIR = JSON.parse(runtime.build_clip(
  'smile',
  JSON.stringify(curves),
  JSON.stringify({ intensityScale: 1 }),
));
const clip = createAnimationClipFromClipIR(clipIR, inspection);
mixer.clipAction(clip).play();

function update(dtSeconds: number) {
  // Live AU/viseme packed frames, then host mixer owns clip lerp.
  applier.applyPackedMorphFrameDelta(runtime.evaluate_morph_frame_delta());
  applier.applyPackedBoneFrameDelta(runtime.evaluate_bone_frame_delta());
  mixer.update(dtSeconds);
}
```

Application-facing JavaScript APIs belong in the host package. Polymer owns
the CLJS character host used by LoomLarge and calls the Wasm exports directly.

### Direct viseme snapshots

`RuntimeCore.get_viseme(index)` and `get_viseme_jaw_scale(index)` read the
canonical direct viseme controls without changing a frame or sampling a host
mixer. Unset, cleared, or out-of-range slots return `0` and `1` respectively.
Hosts can snapshot these values before a temporary mouth-shape preview and
restore them with the existing setters; a zero value releases its live override.

### Preparing a default scene

`createDefaultCharacterSceneRuntime(container, { rendering: { preference: 'auto' } })`
returns a stable scene, camera, lighting controller and `rendering` settings
controller immediately. `ready` reports the initial attempt; failure retains the
controller for recovery through `setSettings`. `getSettings`, `getSnapshot` and
`subscribe` expose the requested preference, actual backend, status and errors.
Live changes prepare and replace only backend resources, preserving the character,
scene, camera, lighting and marker state. `ThreeAnnotationController({ rendering,
scene, camera, domElement: container })` retargets its existing loop and controls;
hosts persist settings and display status without recreating the scene.

Auto tries native WebGPU then falls back only on acquisition/initialization
failure. Explicit WebGPU remains strict; material/preparation errors retain the
previous usable renderer. Device loss is observable and recoverable through the
same controller. `acquireRenderer()` leases protect captures and model mutations;
release them before requesting a switch. `releaseSceneResources()` drains rendering
before detaching and freeing borrowed resources, including after device loss or
scene disposal. Await `runtime.dispose()` before freeing resources on scene teardown.

The existing async factory remains available and rejects after cleanup on initial
failure. Its successful handles expose the same controller and dynamic backend /
renderer getters. The synchronous factory stays WebGL-specific. See the owning
contract for latest-request handling, capture/model leases and teardown ordering.

Three runtime and types are checked at 0.184.0, with a >=0.184.0 runtime peer.
Initial scene readiness does not prepare subsequently added models or establish
first-frame/visual parity. See [renderer selection and scene readiness](docs/SCENE_READINESS.md)
for ownership, version rationale and remaining real-browser acceptance.

### Bilateral snippet channels

AU balance uses the character's left/right: `-1` drives the left side,
`0` drives both, and `1` drives the right. `RuntimeCore.get_au_balance(id)`
returns the stored live balance, clamped by the existing setters to [-1, 1],
with neutral zero for an unset id or after `clear()`. Hosts can save it alongside
`get_au(id)` when serializing a manual pose.

Legacy `build_clip` curve maps use
`options.balanceMap[auId]`, falling back to `options.balance` and then zero.
For `build_typed_clip`, an AU target's explicit `balance` takes precedence:

```js
const channels = [
  { target: { type: 'au', id: 43, balance: -1 }, keyframes: leftWink },
  { target: { type: 'au', id: 43, balance: 1 }, keyframes: rightWink },
];
```

Each channel retains its own keyframe times and intensity scale. Typed AU and
viseme ids belong to separate namespaces, regardless of `snippetCategory`.
Duplicate typed channels for the same AU or viseme and concrete morph target
combine by maximum, including intersections between authored linear curves.
Independent endpoint-balanced channels keep their own inherited or explicit
starts; an inactive opposite-side contribution cannot replace an active
channel's anchor. Composite bone rotations take the maximum AU contribution
after each channel's balance. Legacy curves and distinct semantic ids that
share a morph retain their existing separate tracks and host blending.

A duplicate typed group with multiple enabled contributions to the same morph
cannot also contain an inherited start: compilation rejects that combination
with an error identifying the AU/viseme and destination. Author one curve per
side or explicit starting values. Previously, duplicate ids silently discarded
all but the last channel. Inheritance on supported morph tracks is captured
when the Three clip is constructed. Hosts must construct it again to capture
a fresh pose; this does not change cached host replay or generated bone
inheritance behavior.

For import-time inspection, `captureModelReferencePose` provides an explicit,
immutable transform and morph reference that hosts can reuse after playback.
`extendModelReferencePose` explicitly adds appended skeletons while preserving
the captured parent transforms. It does not infer a bind pose or perform retargeting. See
[Animation reference poses](docs/ANIMATION_REFERENCE_POSES.md) for the contract,
step/linear clip conversion, and remaining import work.

## Presets And Profiles

### Full humanoid skeleton and body authoring

`humanoid.getSpecification` exposes all 55 VRM 1.0 anatomical roles and their
parent/required rules. CC4 maps all 55 to distinct authored bones and supplies
authored AU mappings for fingers, wrists, shoulders, feet, whole body motion, the
spine, head, eyes and jaw. `profile.setHumanoidRoleBinding` edits or clears a role and
retargets its existing actuators. The runtime keeps the same bone/morph evaluator;
other rigs must author their own calibrated axes/ranges and optional muscle
morph targets. See [Body controls](docs/body-controls.md) for migration, validation
and role-assignment contracts.


`cc4` and `fish` are embedded in the Wasm binary. `skeletal` is accepted as a
host-level alias for `fish`; exact custom profiles use
`RuntimeCore.configure_with_profile` and are never silently merged with CC4.

```ts
const ids = wasm.list_presets();
const cc4 = JSON.parse(wasm.get_preset_json('cc4'));
const merged = JSON.parse(wasm.merge_embedded_preset('cc4', JSON.stringify(overrides)));
```

Host-neutral profile authoring operations use one JSON request entry point:

```ts
const result = JSON.parse(wasm.embody_request(JSON.stringify({
  op: 'bone.applyAxisUpdate',
  payload: { profile, boneName: 'CC_Base_Head', axis: 'yaw', update },
})));
```

This boundary keeps ClojureScript and other hosts independent of Rust struct
layouts while ensuring profile semantics execute in Rust.

Speech articulation data belongs to the rig preset. The CC4 profile keeps two
ordered tables beside its canonical `visemeSlots`: `visemeJawAmounts` stores
the jaw opening for each viseme index, and `visemeTongueTargets` stores the AU
target map for that same index. Empty tongue maps mean that viseme has no
tongue overlay. Hosts pass these resolved tables to their lip-sync planner;
they should not recreate rig-specific jaw or tongue values in application code.
The live runtime also compiles both tables: `setViseme` applies the viseme morph,
the mapped jaw opening, and the mapped tongue AUs from the same preset entry.

## Model Analysis

Three.js models are reduced to a renderer-neutral descriptor by
`ThreeModelInspector`. Rust consumes that descriptor for extraction and
validation:

```ts
const clips = serializeAnimationClips(model, animations, inspection);
const report = JSON.parse(wasm.analyze_model_descriptor(
  JSON.stringify(inspection.descriptor),
  JSON.stringify(clips),
  JSON.stringify(profile),
  JSON.stringify({ suggestCorrections: true }),
));
```

## npm releases and PR previews

Production consumers install an exact published `@lovelace_lol/embody` version
from public npm without read credentials and commit their lockfile. The GitHub
source repository stays private. A stable release contains the compiled JS,
TypeScript declarations, and Wasm; consumers do not build Embody from Git.

The `Verify and publish package` workflow publishes a stable npm release after
a push to `main`, or a manual run on `main` with the `ref` input left empty.
It chooses the next patch version, records the source commit in `gitHead`, and
builds and validates once. Stable version selection reads public metadata from
`registry.npmjs.org` anonymously; redirects and failed lookups stop the release.
Metadata reads never transmit publishing credentials. The separate
publish job first requires `npm access get status` to report the existing package
as public, then uses the `npm` environment's `NPM_KEY` to publish the packed
output with public access and creates its Git tag and GitHub release. Stable
releases are serialized through version selection and publication. Provenance
remains disabled for the private source repository. Retrying a published commit
reuses its existing version, and an older unpublished commit cannot replace a
newer source release.

PRs, including drafts, manual runs with an explicit `ref`, and `publish-pkg-pr-new`
repository dispatches run full verification and publish immutable `pkg.pr.new`
previews for testing linked upstream changes. An explicit ref remains a preview
request even when it names `main`; it does not publish to npm. Manual and
repository dispatch requests may include `upstream_pr` to identify their linked PR.

For an Embody → Polymer → LoomLarge feature stack, open every draft from its own
current `main` without waiting for publication. The Polymer PR body declares
`Depends-on: https://github.com/meekmachine/embody/pull/<number>` and the LoomLarge
PR body declares `Depends-on: https://github.com/meekmachine/Polymer/pull/<number>`.
CI resolves the compiled previews in temporary test checkouts. Committed
manifests and lockfiles retain exact stable npm versions; the release coordinator
adopts a stable release containing the change after upstream merge and publication.
Agents do not add preview URLs before opening downstream drafts.
Documentation-only companion PRs use ordinary reciprocal links instead.

After publication, the producing workflow uploads a JSON notification record
without a dispatch credential. The separate `Notify package publication`
`workflow_run` receiver checks out `main`, treats the artifact only as data, and
validates the successful run attempt, repository, workflow, and source commit.
Stable records must identify that run's main commit; linked previews must match
the current open PR head targeting main. The receiver then sends
`upstream-package-published` to `meekmachine/LoomLarge` using
`CROSS_REPO_CI_TOKEN` from the `release-coordination` environment. That token must
not be stored as a repository secret or exposed to a PR build/helper.

Stable notifications contain the exact source SHA and npm version. Preview
notifications contain the full-SHA URL and upstream PR number, or `null` for an
unlinked manual preview. The receiver checks the canonical preview URL once and
fails visibly if it is unavailable. LoomLarge owns downstream dependency updates;
Embody does not edit Polymer or application branches. Missing credentials and
failed notifications fail the receiver visibly. Fork PRs do not send
notifications or receive npm/dispatch secrets.

GitHub activates the receiver after its workflow is present on `main`. The
release-stack PR's first preview remains usable by its immutable URL before
that bootstrap merge; subsequent successful publications notify automatically.

Before enabling stable releases, the existing npm package must have public
visibility and `NPM_KEY` must permit publishing it. No npm read token is required.
Configure both the `npm` and `release-coordination` GitHub
environments to allow deployments from `main` only. Store `CROSS_REPO_CI_TOKEN`
only in `release-coordination`, with permission to dispatch to LoomLarge. These
account, environment protection, and secret settings are prerequisites; source
changes do not configure them. Existing versions are never republished or
overwritten.

## Development

```bash
npm ci
npm run build
npm test
npm run test:package
npm run check:generated
```

`npm run build` creates the JS adapter bundles, declarations, generated
wasm-bindgen glue, and `.wasm` binary in `dist/`. Generated output is not source
and is not committed. Package checks consume that existing build, so run the
build once before `npm run test:package`.

The public Wasm loader returns `EmbodyCore`, derived directly from wasm-bindgen's
generated declarations, including `RuntimeCore` constructors, methods, and
numeric helpers. Instance types can also be imported with `import type` from
`@lovelace_lol/embody/wasm`. Rust exports remain the source of truth for these
signatures; JSON payload contents are still encoded as strings.

Run the build before `npm test` or `npm run typecheck` in a clean checkout, and
rebuild after changing Rust exports. The build generates the Wasm bindings before
TypeScript declarations. Neither typechecking nor package verification rebuilds
the package; CI checks and publishes that same build.

## License

MIT. See [LICENSE](LICENSE) and [AUTHORS.md](AUTHORS.md).

### AU controls and authored animation

Character controls come from the character's saved `auInfo`/`actionInfo`,
`auToBones`, `auToMorphs`, `compositeRotations` and `continuumPairs`. There is
no named body-control catalog or fixed control count. `engine.getAUDescriptors()`
and initialized `getAUDescriptors(profile, modelDescriptor?)` return per-AU
metadata and resolved output support, including labels, signed pair IDs,
bilateral sides, saved morph strength and resolved bone/morph names.

Use `setAU`/`transitionAU`, `setContinuum`, `getAUBalance` and
`setAUMixWeight` for live controls. `buildClip`/`playSnippet` compile numeric
AU curves through the same saved bone/morph evaluator; `balanceMap` and
`mixWeights` are per-AU compilation options. Compilation preserves live state.
Native playback owns interpolation, pause, resume, cancellation and blending.
Reset an authored control by setting its mapped AU values to zero. Hosts select
which mapped AU IDs to reset; unrelated face state and saved mix strengths remain
under their existing owners.

### Reading current AU state

Rust records each admitted AU-curve clip's authored keys, resolved inherited
start, strength and easing. Those records change only at admission or a
strength/easing edit; nothing ticks them. Reads evaluate them on demand at the
native action's time and effective weight, so a fading slot reports
value × weight:

- `readAUContribution(name)` returns one slot's own `{auId: value}`, or `null`
  when it is not playing or was not an AU-curve clip.
- `readAUState()` returns `{live, animated, total, unreadable}`: live control
  values, active AU-curve clip contributions and their sum. Baked/native and
  typed clips animate rig outputs directly and cannot be inverted to AU values,
  so they are listed in `unreadable` rather than estimated.
- `measureAUGoal(name, destinations)` returns `{distance, reversal, current}`:
  the largest travel from the slot's current contribution to `{auId: value}`
  destinations, measured along profile `continuumPairs` as `positive − negative`
  (crossing neutral from 0.3 negative to 0.3 positive is 0.6), and whether it
  reverses the slot's unfinished travel. Callers apply their own timing policy
  and send an ordinary inherited clip with the duration they choose.

Each call does a small amount of work in Rust; read when deciding, not every
frame. See [inherited clip starts](docs/INHERITED_CLIP_STARTS.md) for how
inherited starts and weights resolve.

Named semantic pose/animation APIs and profile `bodyControls` are retired.
Persisted named records must be decoded at the storage boundary to numeric AU
values/curves, using their original profile mappings. `LEGACY_BODY_CONTROL_AUS`
is a deprecated reader-only historical identity snapshot for old CC4 records;
it is never consulted for current controls, actuation or profile compilation.
Unknown legacy names must be reported rather than silently omitted.

### Mesh highlight previews

Rust owns transient mesh highlight state and its renderer-neutral output in
`src/highlighting.rs`, exposed through `RuntimeCore`. This preview is independent
of AU/morph/bone actuation, clip playback, and persisted profile data. Rust resolves
mesh names (including duplicate names) against the configured model, chooses the
default gold color and intensity, computes darker edges in linear color space,
and advances a 400 ms eased transition. Interrupted fades resume from the current
strength; changing targets removes the old preview immediately. Clearing or an
unknown name fades out the current selection. Repeated identical requests do not
restart a fade. Model reconfiguration clears transient highlights.

| Core operation | Contract |
| --- | --- |
| `request_mesh_highlight(name?, color?, intensity?)` | Request a mesh name or omit it to clear. Optional color is packed 24-bit sRGB; intensity is clamped to 0–1, with nonfinite values using the default. |
| `evaluate_mesh_highlight_frame()` | Return the current complete JSON snapshot without advancing time. |
| `advance_mesh_highlight(delta_seconds)` | Advance preview time using the host render clock and return the snapshot. Negative/nonfinite deltas do not advance time. |

Snapshot version 1 contains `highlights`, an array of writes with `meshId`,
`fillColor`, `fillIntensity`, `edgeColor`, `edgeMode: "triangles"`, and `edgeOpacity`.
Colors are linear RGB triplets, strength/opacity are in 0–1, and IDs refer to the
configured model descriptor. The fill is an emissive surface preview and the
edges show triangle topology. An omitted mesh ID means restore its original
appearance and release its preview resources. `{ "version": 1, "highlights": [] }`
clears every preview. The TypeScript contract is exported from
`@lovelace_lol/embody/wasm` without importing a renderer.

Another renderer configures the same `RuntimeCore` from its own model descriptor,
keeps a map of mesh IDs to native surfaces, sends requests, and applies snapshots
from its existing render tick. It does not traverse by name, derive edge colors,
or reproduce the easing curve. For example, after configuring `core`:

```ts
core.request_mesh_highlight('Face');
// Apply the initial snapshot immediately to remove obsolete selections.
applyNativePreview(JSON.parse(core.evaluate_mesh_highlight_frame()));
// Inside the host's existing render tick (seconds, independent of clip speed):
applyNativePreview(JSON.parse(core.advance_mesh_highlight(deltaSeconds)));
```

`applyNativePreview` is the renderer's effect boundary: resolve `meshId`, apply
emission and triangle edges from the supplied values, and remove omitted previews.
The host must advance the core once per frame, even with no playing clips. Pausing
its render clock pauses preview progression; no additional animation loop exists.

For Three, `character.highlightMesh(name, color?, intensity?)` sends the core
request; the existing scene playback binding supplies elapsed seconds and calls
`ThreeFrameApplier.applyMeshHighlightFrame`. The applier only binds mesh IDs and
manages native materials/overlays, deformation, picking exclusion and disposal.
It does not choose colors, resolve names, or sample fades. Temporary materials
are isolated from shared source materials; geometry and skeletons remain owned
by the source model. Native overlays follow source geometry, morph weights and
skeletons. Character rebind/disposal removes them. Direct applier consumers must
call `clearMeshHighlights()` on disposal. Other renderers implement their own
snapshot application; this change does not supply a second native renderer.

### Character-derived studio background

The Three `createCharacterHost` paints its container with soft gradients sampled
from the selected model's material and texture colors. The studio uses the
original visible ink strengths (24/12%, 22/10%, 18%) over a gunmetal base.
Embody owns palette extraction and updates after successful character replacement;
late extraction cannot repaint a newer selection or a disposed host. Disposal
restores the container's original inline background. Explicit saved backgrounds,
including `null` transparency, non-studio scene types and external scenes retain
their authored appearance. Polymer forwards the host; applications do not sample
textures or construct a second scene background.
