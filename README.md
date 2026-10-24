# Embody

Explicit profiles may be empty: `RuntimeCore.configure_with_profile('{}', modelJson)`
loads a static or not-yet-mapped model without selecting an embedded preset.
Missing mappings remain an authoring/validation concern; malformed JSON still
fails configuration. Existing mapped profiles retain their runtime behavior.

Embody is a Rust/Wasm character animation core for facial action units,
visemes, bone controls, baked animation clips, and hair motion. Three.js is a
host adapter, not the runtime implementation.

## Architecture

```text
src/                 Rust source (the Wasm crate) — hair, clips, profiles, runtime
assets/presets/      Embedded typed character profiles
assets/templates/    Embedded humanoid skeleton templates
three/               Thin Three.js inspection/application adapter only
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
- annotation camera/marker math and humanoid template fitting
- on-demand semantic AU reads of active AU-curve clips (no clock or polling)
- renderer-neutral model analysis and packed live frame generation

The host animation library (Three `AnimationMixer`, Unity Animator, etc.) owns
clip playback, lerping, blending, looping, seeking, and crossfades. Rust must
not sample or lerp clips on the hot path.

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
construction. The annotation adapter also owns camera controls, marker scene
objects, labels, selection, and their browser lifecycle; applications provide
the scene/camera/DOM inputs and render controls through the public API.

`ThreeFrameApplier.applyMeshMaterialConfigs(model, profile.meshes)` replays named
mesh visibility and material overrides when a host binds or replaces a profile.
It applies explicit `visible: false` and `visible: true` even without a material
entry, and restores render order, opacity, transparency, depth flags and blending
from `material`. Omitted fields leave the model's current values unchanged.
Polymer calls this adapter during model binding and profile replacement; hosts
do not need a separate mesh-visibility replay loop.

### Annotation runtime

`DPthreeCameraController` and the `DPthree` convenience facade from
`@lovelace_lol/embody/three` own the complete camera and annotation runtime.
`DPthree3DMarkers`, `DPthreeHTMLMarkers`, and the legacy `DPthreeMarkers` adapter
are available for hosts that need a marker-only layer. Rust owns camera
framing/flights/orbits, viewport clipping, curves, visibility factors and
endpoint separation. The Three adapter owns native model inspection,
raycasting, labels, DOM controls, marker expansion/solo/style state and disposal.

Applications pass `AnnotationCharacterConfig`; storage, agency, editor and
character-asset metadata remain host concerns. `loadRegions` defaults to
`resolveAnnotationCharacterConfig`, which resolves annotation and AU mapping
fields from an Embody preset without serializing unrelated host metadata.
An optional `resolveCharacterConfig` callback supports host profile intake.
`prepareRegionsAndMarkersForReveal` accepts an already-resolved profile and
prepares native surface queries while the model pose is still stable.
Initial queries yield to a browser paint between meshes once a 4 ms slice is
spent. Each native mesh raycast is indivisible; a large mesh can still cause a
frame drop, and slicing does not reduce total raycast CPU time. Interactive
annotation changes retain synchronous queries so a marker samples one pose.
Replacement, clearing and disposal cancel stale loads before scene commits.
New 3D markers and separated endpoints invalidate the cached camera layout.
Visible markers receive the current zoom sizing and Rust viewport constraints
before paint; hidden markers receive that layout before reveal captures label
scales. Viewport clipping also follows the animated label size during reveal
overshoot. Markers added during a reveal stay hidden until its layout pass resumes.

For first reveal, call `controller.prepareModelForRender(model, { signal })`
from the existing `beforeReveal` callback (or directly before attaching the
model). It compiles the model's visible surfaces, then uses the controller's
existing render loop for one complete scene preparation draw. No host warmup
queue, shadow proxies or texture preparation loop is needed. The promise rejects
on failure or cancellation; retain borrowed model/scene/renderer resources until
it settles, even after `controller.dispose()`. This prepares visible variants,
not every future hidden material or animation state. See the
[model readiness contract](docs/SCENE_READINESS.md#model-readiness).

`createMarkerVisibilityLifecycle` owns automatic reveal/hide timers;
`createRuntimeAnnotationPreviewLifecycle` owns temporary authoring previews.
React hosts forward user events and subscribe to controller state. They do not
need local copies of the camera, marker, placement or timer algorithms.
The convenience facade delegates to one controller-owned marker layer.

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
scene, camera, lighting and marker state. `DPthreeCameraController({ rendering,
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
