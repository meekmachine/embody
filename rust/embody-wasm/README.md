# Embody Wasm Core

This crate provides the Rust/Wasm artifact used by the host-neutral Embody core.
The npm build now produces the generated Wasm package under `dist/wasm` and
the public `@lovelace_lol/embody/wasm` entrypoint initializes it explicitly.

The current Rust surface focuses on batched numeric operations that match the
core JS/Wasm boundary shape:

- inputs are number slices / typed arrays
- outputs are packed numeric buffers
- no Three.js, Babylon, Unity, or host objects cross the boundary

Skeleton fitting, fit metadata, and automatic skin binding should follow the
same descriptor boundary. Rust can own host-neutral math over mesh descriptors,
template skeleton descriptors, rest-pose transforms, bone envelopes, topology,
inverse bind data, normals, scale, and manual fit adjustments. Host adapters
must still own real mesh, material, GLB, skinning, and engine-object mutation.

Automatic skin binding is not a per-frame Wasm target by default. It should be
treated as research/offline-capable work until fixtures prove acceptable
deformation quality for clothing, hands, face, hair, non-standard poses, and
other hard cases. The runtime package should expose stable metadata and helper
math first, then only move weight generation into Rust/Wasm if benchmarks and
visual tests justify doing it in the browser.

Build locally:

```sh
cargo test --manifest-path rust/embody-wasm/Cargo.toml
cargo build --manifest-path rust/embody-wasm/Cargo.toml --target wasm32-unknown-unknown --release
npm run build
node scripts/smoke/package-exports.mjs
```

The npm build uses `wasm-pack` to generate JS glue and the `.wasm` binary after
`tsup` writes the TypeScript package artifacts. Consumers should call
`initEmbodyCore()` from `@lovelace_lol/embody/wasm` before using direct Wasm
exports.
