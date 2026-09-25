# Embody

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

The TypeScript adapter is intentionally limited to operations that require
Three.js objects: scene traversal, ClipIR ↔ `AnimationClip` conversion, frame
application, material writes, model loading/disposal, and default scene
construction. The annotation adapter also owns camera controls, marker scene
objects, labels, selection, and their browser lifecycle; applications provide
the scene/camera/DOM inputs and render controls through the public API.

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

The head prefers the camera bearing, with configurable following. The legacy
`lock_head_to_camera` flag retains this preference but permits head movement
when eyes saturate, or when eyes are disabled. Eye angles are solved in the
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
controls)` after it. Controls are the current positions of existing motor
tracks, rather than newly started transitions. `readControlState({worldTarget})`
provides initial bearings for a handoff from the rendered pose. When replacing
legacy head controls at reduced intensity, also provide `headIntensity` and
the evaluated local `headBaseQuaternion` with those controls excluded. The
helper inverts gain in joint coordinates and reports `headSeedLimited` if
the existing pose cannot be represented within the new bounds. Reading the
seed does not modify the rig.

The helper solves in the actual joint hierarchy, compensates head/neck motion,
and aims each eye from its own origin. It honors signed actuator limits and
reports angular residuals for unreachable targets. Head intensity scales joint
movement from the evaluated base pose; eye intensity bounds the available eye
excursion. The optional `profile.gazeCalibration` supplies bone-local
`head`, `leftEye`, and `rightEye` optical axes and `modelUnitsPerMeter`.
Without explicit optical axes, signed yaw/pitch bindings determine the optical
frame. Unresolvable joints remain untouched and are reported in diagnostics.

`solve_profile_viewer_space_gaze_scaled` adds `world_units_per_meter` as its
last argument. Multiply the authored units-per-meter calibration by the
presentation's uniform root scale. The original viewer solver keeps its
existing scale-one behavior. Neither solver infers physical webcam/display
placement from face landmarks.

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
