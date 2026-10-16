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

## Connector entry points

Use `@lovelace_lol/embody/wasm` for a connector to another animation host. That
entry point initializes the Rust/Wasm module and exports `ClipIR`, `ClipIRTrack`,
`ClipIRTarget` and `ClipIRChannel` as TypeScript data types. Its runtime and
declaration imports do not require Three. The package declares Three as an
optional peer so a Wasm-only consumer can install Embody without a renderer.

`@lovelace_lol/embody/three` supplies the implemented Three connector and still
exports the same ClipIR types. The package root retains its existing Three
re-exports for compatibility. Applications importing either of those entry
points must install the supported Three peer themselves. Importing the root
is not a renderer-neutral shortcut.

The ClipIR fields follow `src/clip.rs`: optional clip `id` and JSON `metadata`,
`name`, `durationSeconds`, channel records (`id`, `kind`, optional `name`) and
tracks. Tracks carry stable target IDs, `valueType`, second-based `times`, flattened
`values`, optional `interpolation`, `inheritStart` and `sourceName`. Quaternion
values use XYZW order. Rust emits duration, channels and track/channel IDs;
the TypeScript declarations retain the existing optionality of those fields for
callers constructing minimal Three adapter inputs. The declared target fields
cover the current concrete object targets; Rust also preserves custom JSON
target payloads. These types describe data and do not validate parsed JSON.

## Playback ownership

A connector maps model descriptor IDs to its own engine objects and converts
compiled ClipIR into that engine's native tracks. AU/viseme/profile mapping
stays in Rust. Capture an `inheritStart` value when materializing the clip for
playback, preserve its interpolation mode and use the same authored reference
pose for additive conversion. Unsupported output kinds should be reported by
the connector rather than replaced with a new semantic mapping.

The host animation library owns advancing time, interpolation, blending,
looping, pause/resume, seeking and completion. The application's existing frame
driver advances that library. A connector must not add a playback RAF loop,
an elapsed-time sampler, or timers that guess when native actions finish.
Completion comes from the native action lifecycle; cancellation and disposal
release the corresponding native resources and reject stale completions for a
replacement request. A timer that schedules a future request is separate from
playback and must not act as its clock.

`ThreeClipSlots` follows this boundary: it receives an existing mixer, creates
ordinary native tracks, and observes native completion. At replacement it reads
the outgoing action's local time and samples that action with Three's own
interpolants. Its zero-delta updates reapply bindings at command boundaries;
it does not advance animation time or schedule frames. Another connector can
implement the corresponding lifecycle using its host's native animation API;
Embody does not currently ship a second renderer connector or a universal
playback implementation.

These rules do not imply the legacy paths have all been migrated. The existing
`ThreeGazeFocus` pose constraint still needs to be replaced before claiming that
all character poses come from native clip playback. The new camera-relative-angle
feature and annotation camera/marker migration remain separately deferred.
Rust's optional `HairPhysicsSolver` is a caller-driven
physics integrator, not the character clip playback engine. Finite curve
sampling during semantic clip compilation also remains preparation work;
it does not advance a playing clip.
