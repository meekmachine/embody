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

The current Three.js adapter is in `three/`. Polymer owns the application host
API (including `AnimationMixer` scheduling) and calls the Wasm module
directly; LoomLarge does not import Embody internals.

`ThreeAuContribution` evaluates sampled unsigned AUs in an isolated canonical
Rust runtime, then composes the resulting reference-relative bone deltas and
mapped morph contributions onto the current authored pose. Its renderer state
records only the writes needed for conditional restoration; it does not copy
profile mapping rules, choose gaze targets, allocate head/eye movement, or own
strength and timing. `readPose()` exposes current/reference matrices and Rust's
resolved actuator/optical facts so Polymer can plan ordinary AU samples. See the
[sampled contribution contract](../README.md#sampled-au-contributions-and-observed-geometry).
