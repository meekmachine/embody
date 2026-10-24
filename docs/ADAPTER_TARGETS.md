# Adapter Boundary

Embody's renderer-neutral runtime is Rust/Wasm. A renderer adapter may only:

1. inspect engine objects and serialize stable IDs plus primitive data;
2. convert ClipIR ↔ native clips (`createAnimationClipFromClipIR`,
   `serializeAnimationClips`);
3. apply packed Rust **live** frame writes to engine objects;
4. schedule ClipIR on the host animation mixer (playback/lerp/blend);
5. perform engine-owned resource operations such as loading and disposal;
6. observe the rendered pose once per host render step, after the mixer has
   sampled, and pass primitive data to Rust (the Three character host does this
   for the [hair head response](../README.md#hair-motion)). Observation borrows
   the host's render step; an adapter must not start its own loop, interval or
   animation frame request for it.

An adapter must not resolve profiles, classify mesh categories, or maintain a
second copy of AU/viseme runtime state. Clip time evaluation, blending, and
lerping belong to the host mixer — not Rust.

The current Three.js adapter is in `three/`. Polymer owns the application host
API (including `AnimationMixer` scheduling) and calls the Wasm module
directly; LoomLarge does not import Embody internals.
