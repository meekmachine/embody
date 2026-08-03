# Adapter Boundary

Embody's renderer-neutral runtime is Rust/Wasm. A renderer adapter may only:

1. inspect engine objects and serialize stable IDs plus primitive data;
2. serialize native animation tracks into Rust ClipIR inputs;
3. apply packed Rust frame writes to engine objects;
4. perform engine-owned resource operations such as loading and disposal.

An adapter must not resolve profiles, classify mesh categories, evaluate
animation time, blend channels, interpolate transitions, or maintain a second
copy of runtime state.

The current Three.js adapter is in `three/`. Polymer owns the application host
API and calls the Wasm module directly; LoomLarge does not import Embody
internals.
