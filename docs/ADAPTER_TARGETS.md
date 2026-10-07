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

VRM Animation body interchange follows the same split. Rust owns Mixamo role
mapping, reference/hierarchy validation, rotation basis math, hip-height/unit
conversion and the portable GLB contract. Three inspects explicit references or
skin bind inverses, parses FBX, releases parser resources and materializes native
clips. Playback/blending remain host-owned. No Three sampling loop or alternative
JavaScript retargeting core is introduced. See [the supported contract](ANIMATION_REFERENCE_POSES.md#mixamo-fbx-and-vrm-animation-body-interchange).
