# Embody Host ABI (the waist)

Embody is an hourglass: wide host adapters, a narrow packed ABI, and a Rust/Wasm
core that owns all animation logic.

```
  Three / Babylon / Unity / MemoryHost
              \    |    /
               \   |   /
            packed ABI v1
                   |
              Rust RuntimeCore
```

## Rules

1. **No host objects cross the waist.** Wasm never sees Three meshes, Babylon
   morph managers, or Unity GameObjects.
2. **Hosts only:** inspect a model → configure the core → forward controls →
   apply packed frame output → schedule that engine’s clip player (Mixer, etc.).
3. **Rust owns:** state, bindings, evaluation, transitions, presets, profile
   merge, ClipIR compile, hair solvers, fit math.

## Version

| Symbol | Value |
|--------|------:|
| `CORE_ABI_VERSION` / `EMBODY_CORE_ABI_VERSION` | **1** |

Bump the version when strides or field order change. Hosts must reject mismatches.

## Live frame strides

### Morph FrameDelta (stride 4)

`[meshId, morphTargetId, value, mode]`

- `mode`: `0` = absolute, `1` = additive

### Bone FrameDelta (stride 9)

`[boneId, px, py, pz, qx, qy, qz, qw, flags]`

- `flags` bit0 = has position, bit1 = has rotation

## Configure intake

Hosts call `RuntimeCore.configure*` with:

- **Preset path:** `configure_with_preset(presetId, overrideJson, modelJson)`
  — embedded CC4/fish live inside Wasm; overrides are host-supplied JSON.
- **Exact path:** `configure_exact_profile(profileJson, modelJson)` when the
  host owns a full custom profile.
- **Legacy:** `configure(profileJson, modelJson)`

`modelJson` is a `ModelDescriptor` (see `src/core/contracts/model.ts`).

## Authored animation

Clip authoring compiles to host-neutral **ClipIR** in Rust
(`compile_clip` / `compile_clip_curves`). Each host converts ClipIR into its
native player (Three `AnimationClip` + Mixer, Babylon animation groups, etc.).

## TypeScript mirrors

Numeric constants and adapter interfaces live in `src/core/contracts/`
(`abi.ts`, `model.ts`, `frame.ts`, `clip.ts`, `host.ts`). Host packages under
`src/hosts/` implement those interfaces.
