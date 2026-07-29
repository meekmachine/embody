# Host Adapter Targets

Embody keeps a **Rust/Wasm required core**. TypeScript host adapters only talk
to that core through the packed ABI (see [HOST_ABI.md](./HOST_ABI.md)).

## Architecture

| Layer | Owns |
|-------|------|
| `@lovelace_lol/embody` Wasm core | State, bindings, eval, transitions, presets, ClipIR, hair/fit solvers |
| Packed ABI (waist) | `ModelDescriptor` in; packed morph/bone `FrameDelta` + ClipIR out |
| `src/hosts/three` | Three inspect / apply / Mixer schedule (`RustEmbodyHost`) |
| `src/hosts/memory` | Engine-agnostic proof host (plain maps; no renderer) |
| Fat `Embody.ts` (legacy) | Exact-custom / authoring surface until full cutover |

Hosts must not reimplement AU solving, profile merge, or preset blobs as
runtime truth. Those live in Rust.

## Three.js (first host)

Adapter pieces (under `src/hosts/three` + `src/engines/three` helpers):

- `ThreeModelInspector` → `ModelDescriptor`
- `ThreeFrameApplier` ← packed FrameDelta
- `RustEmbodyHost` → thin driver over `RuntimeCore`
- `ThreeAnimationSystem` → host-only Mixer / snippet playback

R3F should wrap the Three host; it does not need a separate core.

## MemoryHost (ABI proof)

`src/hosts/memory` drives `RuntimeCore` and stores morph/bone results in plain
JS maps. Any future engine host should be able to follow the same pattern.

## Babylon.js (next renderer host)

Expected pieces against the same contracts:

- `BabylonModelInspector` → `ModelDescriptor` (morph target managers → ids)
- `BabylonFrameApplier` ← packed FrameDelta
- `BabylonClipAdapter` ← ClipIR → animation groups

Primary risk: morph targets are manager-based, not `morphTargetInfluences` arrays.

## Unity (bridge host)

Treat Unity as a native/bridge consumer of the same ABI (C# applier for
blendshapes/bones, ClipIR bake or runtime bridge). Not an npm peer of Three.

## Recommended order

1. Keep Three live path on `RustEmbodyHost` + packed FrameDelta.
2. Prove non-Three with MemoryHost tests.
3. Cut LoomLarge / Polymer preset characters fully onto the thin host.
4. Delete fat `Embody.ts` / `TsRuntimeCore` once exact-custom + authoring parity lands.
5. Prototype Babylon inspect + apply.
6. Unity bridge once FrameDelta / ClipIR stay stable across hosts.
