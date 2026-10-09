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
- profile-aware screen-space gaze geometry for eye/head AU trajectories
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

### Gaze geometry contract

`solve_profile_screen_space_gaze` and `solve_profile_viewer_space_gaze` return
14 floats: combined target XY, eye target XY, head target XY, total yaw/pitch,
camera yaw/pitch, eye-to-camera distance, and viewer world XYZ. XY outputs are
signed AU intensities in [-1, 1]; positive Y is up and horizontal direction is
subject-relative. Angular values are degrees.

Pass current world camera position/quaternion, character eye midpoint, and
model quaternion. The viewer solver takes normalized image XY (+Y up) and
depth behind the virtual camera; depth and all positions must share scene
units. Convert physical webcam estimates before calling and supply the actual
source FOV/aspect. Zero viewer XY extends the character-eye-to-camera bearing,
so the character looks at the viewer even when scene framing puts its eyes
away from image center. Offsets retain the camera's right/up axes; when the
camera coincides with the eyes, its local +Z supplies the fallback bearing.
The depth guard is 0.2–10 scene units. Mouse and webcam can share this contract
when they use the same calibration.

Ordinary head following participates toward the common target from calibrated
model-neutral +Z: `head_follow_fraction` is a share of the target yaw/pitch,
defaulting to 0.35 for a non-finite value. Zero prefers neutral, one follows the
full target, and eye overflow can recruit more head movement within its limits.
The explicit `lock_head_to_camera` flag instead prefers the camera bearing while
eyes can reach; a zero follow fraction alone does not select that policy. When
eyes are disabled the head carries the target regardless of follow or lock.
This removes the previous implicit camera bias, which could point the head
opposite the selected target when the camera was off-center. Hosts that intend
camera-facing behavior must request the explicit viewer-solver lock; Polymer's
`headFollowEyes: false` maps to zero participation, not an implicit lock.
Eye angles are solved in the
rotated head frame, using yaw then pitch to match runtime composition. Limits
and AU normalization are directional and include each binding's scale. Missing
or morph-only mappings contribute no inferred angular capacity.

The profile must describe the active rig with calibrated semantic axes:
model +Z is forward, +Y is up. This ABI does not include the skeleton's rest
frames or optical axes, per-eye origins, current animated head pose, or
webcam-to-display calibration. It solves an endpoint in the assumed calibrated
basis; it does not provide binocular convergence or compensate intermediate
head motion. Shared eye commands use the smaller mapped eye capacity; unequal
left/right ranges need separate calibration. Hosts must compose the requested
rotations without averaging independent yaw/pitch clips together.

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
58 body controls for fingers, wrists, shoulders, feet, whole body motion, the
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

## Pose-aware focus

`ThreeGazeFocus` from `@lovelace_lol/embody/three` applies a focus constraint
inside an animation runtime. It has no clock or target-selection policy:
call `restore()` before evaluating the base animation, then `apply(request,
controls)` after it. Restoration compares quaternion orientations independently
of Float32 sample norms, preserving the exact authored sample and any newer
authored orientation. Repeated applications between mixer ticks do not accumulate
the constraint's previous correction. Controls are the current positions of existing motor
tracks. The optional sampled `controls.headIntensity` and `controls.eyeIntensity`
override the matching request fields, so the host can animate configuration
changes on its existing motor tracks. Both mean contribution in [0, 1]: zero
preserves the evaluated base, one applies the full solved excursion, and legacy
values above one normalize to one. Intermediate eye contribution proportionally
reduces the correction; it does not shrink anatomical limits. Reduced eye
contribution deliberately leaves focus error. These controls do not amplify
input displacement or control response speed.

During travel, the remaining sampled bearing rotates the requested finite
target. At the endpoint that rotation becomes identity, reaching the exact
world target continuously. There is no settled-threshold switch between targets
constructed from the authored and tracking-shifted eye origins; a larger head
turn must not introduce a final eye snap.

Pass `{ referencePose }` as the constructor's third argument, reusing the
reference captured at import. Without it, construction captures the current
pose, so callers must construct before playback. The head solves its bounded
gaze excursion in that reference hierarchy under the model's current scene
transform, then composes the excursion onto the evaluated authored head pose.
Head and neck gestures retain their motion instead of being cancelled or
reversed by tracking. Each eye then solves toward the same finite target from
its own origin in the final animated hierarchy. Full eye contribution retains
binocular focus wherever the combined authored motion and gaze are reachable;
otherwise diagnostics report the remaining angular error and limits. Authored
gestures are not suppressed to force a target into range. The signed limits
bound the tracking excursion; they do not clamp the final authored pose plus
that excursion against a neutral-reference joint range. Authored motion can
therefore take the combined pose beyond that range or the eyes' reach.

`readControlState({worldTarget, headIntensity, eyeIntensity})` provides initial
motor bearings without changing the rig. It inverts existing focus contributions
against their saved base, and seeds zero added head excursion when enabling on
a purely authored pose. When replacing legacy AU controls, also provide the
evaluated local `headBaseQuaternion` and/or `eyeBaseQuaternions` (a map keyed by
bone name), with those legacy controls excluded. `headSeedLimited` and
`eyeSeedLimited` report poses that cannot be represented by the bounded motor
bearings. Parallel legacy eyes cannot both be preserved exactly by a shared
finite target; inverse eye contribution avoids double attenuation but does not
remove that convergence residual. This helper supplies no handoff transition
clock; the host owns activation policy and movement timing.

The optional `profile.gazeCalibration` supplies bone-local
`head`, `leftEye`, and `rightEye` optical axes and `modelUnitsPerMeter`.
Without explicit optical axes, signed yaw/pitch bindings determine the optical
frame. Unresolvable joints remain untouched and are reported in diagnostics.

`solve_profile_viewer_space_gaze_scaled` adds `world_units_per_meter` as its
last argument. Multiply the authored units-per-meter calibration by the
presentation's uniform root scale. The original viewer solver keeps its
existing scale-one behavior. Neither solver infers physical webcam/display
placement from face landmarks.

`solve_profile_tracking_gaze` maps normalized display-right/up controls to the
profile's full signed head AU rotation range. Pass `head_follow_fraction = 1`
for full participation: on an aligned display axis, an input endpoint of +/-1
requests the same head rotation as the corresponding AU at intensity 1. Binding
scale and asymmetric `maxDegrees` remain authoritative. Camera distance and FOV
do not reduce this range. Intermediate inputs interpolate between the bounded
camera bearing at zero and the corresponding signed endpoint; camera roll
rotates the display axes into the model frame. With head tracking disabled,
the target spans the eye AU range instead.

The signature is `(profile_json, tracking_target, camera_position,
camera_quaternion, gaze_origin, model_quaternion, eyes_enabled, head_enabled,
head_follow_fraction, lock_head_to_camera, world_units_per_meter)`. It returns
the same 14-float layout as the existing physical projection solvers. Target Z
is depth in meters, clamped to 0.2–10 before scene scaling; it sets a finite
binocular focus distance without attenuating the angular range. X/Y clamp to
[-1, 1], nonfinite coordinates become zero, invalid positive depth/scale use
0.8/1 respectively, and absent AU bindings supply no angular capacity.

This is an input-range mapping, not a physical reconstruction of the viewer's
position. The existing screen/viewer projection APIs retain their contracts.
Consumers must select this entry point and request full head participation to
use it; adding the export alone does not change LoomLarge tracking. Eye focus
still uses the resulting finite target and reports residual error when reduced
strength, authored motion, or rig limits make that target unreachable.

## npm releases and PR previews

Production consumers install an exact published `@lovelace_lol/embody` version
from npm and commit their lockfile. A stable release contains the compiled JS,
TypeScript declarations, and Wasm; consumers do not build Embody from Git.

The `Verify and publish package` workflow publishes a stable npm release after
a push to `main`, or a manual run on `main` with the `ref` input left empty.
It chooses the next patch version, records the source commit in `gitHead`, and
builds and validates once. The separate publish job uses the `npm` environment's
`NPM_KEY` to publish the packed output from that job, then creates its Git tag
and GitHub release. Stable releases are serialized through version selection and
publication; failed registry lookups stop the release. Retrying a published
commit reuses its existing version, and an older unpublished commit cannot
replace a newer source release.

Non-draft PRs, manual runs with an explicit `ref`, and `publish-pkg-pr-new`
repository dispatches publish immutable `pkg.pr.new` previews. These are for
testing linked upstream changes. Before Polymer publishes a stable npm release,
replace its Embody preview URL with the exact stable npm version containing
those changes. An explicit ref remains a preview request even when it names
`main`; it does not publish to npm.

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

### Semantic poses and generated motion

`RuntimeCore.get_semantic_pose_catalog_json()` returns the configured profile's
motion identifiers, direction labels, VRM roles, resolved bone/morph names and
per-direction model support and available sides. VRM names anatomy; profile motion IDs name authored
actions. Hosts should send only supported directions to generation prompts,
along with their bounds: intensity and morph strength `0..1`, bilateral balance
`-1` character-left, `0` both, `1` character-right. Amounts are normalized authored
motion, not radians or world-space rotation.

`capture_semantic_pose_json()` returns `{version:1,controls:[{controlId,positive,
negative?}]}`. Each direction stores intensity, balance and morphStrength
independently, preserving opposed action values. These are manual runtime
controls; capturing an arbitrary mixer/baked pose would require pose inference.
`validate_semantic_pose_json()` fills omitted settings without mutation.
`apply_semantic_pose_json()` validates the complete input before replacing Body
actions, preserving unrelated facial state. Either direction may be omitted;
a control requires at least one. Known missing outputs remain portable to partial
rigs; unknown IDs, duplicate actions and invalid bounds fail. Applying a semantic pose releases prior direct overrides on its exact mapped
mesh/target IDs, preserving unrelated facial overrides and same-named targets on
unmapped meshes.

`build_semantic_clip(name, animationJson, optionsJson)` compiles
`{version:1,durationSeconds,tracks:[{controlId,direction,balance?,morphStrength?,
keyframes:[{time,intensity}]}]}` through the same AU/bone/morph evaluator.
Direction is `positive` or `negative`; time is seconds. Unsupported directions,
unknown controls, duplicate actions and non-increasing/out-of-range keys fail.
`options.faceCurves` accepts additional non-Body AU curves so face and body compile
together, including overlapping mapped bones. Compilation preserves live state;
per-track morph strength changes only the compiled output. The host mixer owns
playback and interpolation, as with existing snippets.

Catalog `availableSides` identifies actual mapped left/right/center outputs.
Generated animations reject a negative balance without a left output or positive
balance without a right output; balance zero may drive the remaining side of a
partial rig. Stored static poses retain their portability across missing outputs.
`evaluate_semantic_body_bone_frame()` returns exact Body-owned properties including
neutral values, allowing an explicit semantic pose/reset to replace old raw bone
edits without touching unrelated properties.
