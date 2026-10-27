# Adapter Boundary

Embody's renderer-neutral runtime is Rust/Wasm. A renderer adapter may only:

1. inspect engine objects and serialize stable IDs plus primitive data;
2. convert ClipIR ↔ native clips (`createAnimationClipFromClipIR`,
   `serializeAnimationClips`);
3. apply packed Rust **live** frame writes to engine objects;
4. schedule ClipIR on the host animation mixer (playback/lerp/blend);
5. perform engine-owned resource operations such as loading and disposal.

An adapter must not resolve profiles, classify mesh categories, or maintain a
second copy of AU/viseme runtime state. Clip time evaluation, blending, and
lerping belong to the host mixer — not Rust.

Continuous hair is a Rust simulation, not clip interpolation. After native
mixers sample, an adapter may pass the resolved head bone's actual local
quaternion, its captured reference, and renderer elapsed seconds to
`RuntimeCore.build_hair_response_clip`. Rust resolves the head role and owns all
position, velocity, gravity and ambient phase. The adapter caches only native
bindings and stages the returned zero-neutral morph offsets on one persistent
additive action. That action applies them during the next ordinary mixer sample;
there is no second mixer pass, render loop or direct post-mixer morph write.
See the [hair response contract](INHERITED_CLIP_STARTS.md#hair-response-during-head-retargeting).

The current Three.js adapter is in `three/`. Polymer owns agency scheduling and
uses Embody's character/native playback adapter for renderer resources.
LoomLarge supplies scene inputs and saved configuration through Polymer.

Annotation adapters additionally capture raw pointer/wheel input, inspect native
bounds/vertex attributes and execute Rust-planned native raycasts. Rust's
`AnnotationRuntime` owns camera integration, regions, target selection, marker
placement/state and packed layout. `AnnotationLifecycle` owns deadlines; a browser
timer only wakes it to emit effects. The adapter keeps native object handles and
promise/callback resources, never an independent annotation state machine. See
[the annotation contract](../README.md#annotation-runtime).
