# Embody Wasm Prototype

This crate is an optional Rust/Wasm prototype for the host-neutral Embody core.
It does not replace the TypeScript runtime yet.

The current prototype focuses on batched numeric operations that match the
future JS/Wasm boundary shape:

- inputs are number slices / typed arrays
- outputs are packed numeric buffers
- no Three.js, Babylon, Unity, or host objects cross the boundary

Build locally:

```sh
cargo test --manifest-path rust/embody-wasm/Cargo.toml
cargo build --manifest-path rust/embody-wasm/Cargo.toml --target wasm32-unknown-unknown --release
```

`wasm-pack` is intentionally not required by the npm build yet. When benchmark
data justifies using the Wasm runtime by default, the package step can add
generated JS bindings and include the Wasm artifact in the npm tarball.
