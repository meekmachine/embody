# Recent Changes

- Added a profile-aware screen-space gaze solver that uses the rendered camera
  pose and projection, the character eye origin, model orientation, and
  authored eye/head AU limits to return exact eye-contact trajectories.

## Rust-only core

- Made Three.js morph authoring transactional: batches preserve existing morph
  data and mode, convert incoming targets when needed, and dispose replaced
  geometries once they are no longer shared.
- Moved the Rust crate to repository-root `src/`; there is no nested Rust
  project.
- Ported profile/preset data, authoring, validation, model analysis, procedural
  controls, transitions, baked and dynamic clips, playback state, events, hair
  physics, and appearance normalization to Rust/Wasm.
- Embedded CC4, fish, and humanoid template JSON as Rust assets.
- Replaced the TypeScript runtime with a bounded Three.js adapter and Wasm
  loader. Generated wasm-bindgen JavaScript remains build output only.
- Removed the old TypeScript implementations and compatibility runtime entry
  points. Polymer now owns the host API used by LoomLarge.
