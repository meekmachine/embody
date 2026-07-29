# Secondary Host Adapter Targets

Embody keeps Three.js as the first supported host while making the core
contracts realistic for Babylon.js, React Three Fiber, and Unity.

## Current Boundary

The shared package has three layers:

- **Rust/Wasm core** (`@lovelace_lol/embody/wasm`): required host-neutral engine.
  Owns preset/profile data (`ProfileData`), YAML-authored embedded presets,
  binding compilation, live AU/viseme/bone solving, clip IR, hair/camera/math.
- **`@lovelace_lol/embody/core`**: thin TypeScript contracts + Wasm facade only.
  No TypeScript runtime solver fallback.
- **`@lovelace_lol/embody/three`**: Three.js inspection, packed frame writes,
  mixer/clip actions, scene load/dispose. This is the only intended long-term
  TypeScript surface besides package/Wasm glue.
- **`@lovelace_lol/embody`**: compatibility root while the fat facade shrinks.

## Profile ownership and host wire format

- **Authored in Embody:** presets live as YAML under
  `rust/embody-wasm/assets/presets/*.yaml`, deserialized into Rust `ProfileData`
  (compile-time embed via `build.rs`).
- **Runtime from LoomLarge / Polymer:** still JSON. The browser sends either:
  - `{ presetId, overrideJson, modelJson }` → `RuntimeCore.configure_with_preset`
  - `{ exactProfileJson, modelJson }` → `RuntimeCore.configure_exact_profile`
- LoomLarge must not expand TS preset dumps into the Rust host. Sparse DB
  overrides + embedded preset id, or a complete custom exact profile.

The adapter contract is intentionally numeric:

- models are described as `ModelDescriptor`
- runtime output is packed `FrameDelta` buffers
- authored animation output is `ClipIR`
- host adapters own object lookup and mutation

This keeps Rust/Wasm, Babylon, R3F, and Unity from needing Three.js objects.

## Required Rust/Wasm Init

Consumers must `await initEmbodyCore()` (or use `Embody.create(...)`) before
constructing a runtime or calling sync helpers such as `getPreset(...)`.
If Wasm cannot load, Embody fails loudly. There is no silent TypeScript core.

## Babylon.js

Babylon should be the first non-Three runtime target after the Three adapter is
stable because its browser/npm shape is closest to the current host.

Expected adapter pieces:

- `BabylonModelInspector`: convert Babylon meshes, skeleton bones, morph target
  managers, and animation groups into `ModelDescriptor`.
- `BabylonFrameApplier`: apply packed `FrameDelta` buffers to morph target
  influences, bone transforms, and mesh visibility/material properties.
- `BabylonClipAdapter`: convert `ClipIR` into Babylon animations and animation
  groups.

## React Three Fiber

R3F should not need a separate core runtime. It should be a React integration
for the existing Three adapter.

## Unity

Unity should be treated as a bridge target, not a direct npm runtime target.
Export `ModelDescriptor`, packed frame buffers, and `ClipIR` to Unity-side C#
or WebGL interop.

## Recommended Order

1. Keep the Three live path on Rust `RuntimeCore` + `ThreeFrameApplier` only.
2. Route Three dynamic clips through Rust clip compilation + `ThreeClipAdapter`.
3. Add a small R3F wrapper because it reuses the Three adapter.
4. Prototype Babylon descriptor + frame application.
5. Only start Unity once packed frame/`ClipIR` contracts are stable enough for a
   bridge format.
