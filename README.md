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
construction.

## Runtime Use

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

## Development

```bash
npm ci
npm run rust:test
npm run typecheck
npm run build
npm run test:exports
```

`npm run build` creates the JS adapter bundles, declarations, generated
wasm-bindgen glue, and `.wasm` binary in `dist/`. Generated output is not source
and is not committed.

## License

MIT. See [LICENSE](LICENSE) and [AUTHORS.md](AUTHORS.md).
