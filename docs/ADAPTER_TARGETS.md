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

The current Three.js adapter is in `three/`. Polymer still implements the legacy
application host, including mixer scheduling. That is migration debt, not the
target ownership rule. [Polymer #299](https://github.com/meekmachine/Polymer/issues/299)
moves playback commands and binding APIs into Embody, leaves public forwarding
in Polymer, and keeps native time/interpolation/blending in the selected host.
The [staged migration](native-playback-migration.md) identifies the remaining
connector, character facade and consumer work.

## Rust command boundary

`NativePlaybackSession` is a generated Wasm export returned by
`initEmbodyCore()`. It owns validation, binding generations and request lifecycle;
it stores no elapsed playhead and has no frame-update method. It accepts compiled
ClipIR produced by the existing semantic compiler or a native import adapter.
Compilation and native blend weight remain distinct operations.

Every method returns a JSON batch with `commands` and `events` arrays; `play`
also returns a `handle`. These are private connector operations, not a new
Polymer agency stream or central scheduler. Agency admission and behavior stay
where they are. A non-Three fake connector in the package tests exercises the
same transport without engine objects.

### Input and output data

`play(clipJson, optionsJson)` requires a concrete ClipIR with a nonempty name,
finite nonnegative `durationSeconds`, declared channels, and concrete tracks.
Track samples have finite values, nonnegative nondecreasing times, and the
scalar/vec3/quaternion width required by the target. Authored keys may extend
beyond an explicit playback duration; seek remains bounded by that duration.
Separate clips and separate tracks may share a concrete target. Preserve these
contributions for the native host rather than pre-blending them here. Concrete
targets are morphs, bone/object transforms and mesh visibility. Semantic AU or
viseme targets must go through the existing Rust compiler first. Unsupported
data fails before an existing playback is replaced.

Play options use these fields:

| Field | Meaning |
| --- | --- |
| `replace` | Optional existing handle to release before starting this request. Omit to allow independent overlapping playback, including repeated plays of the same clip name. |
| `startSeconds` | Finite position from zero through clip duration. Defaults to zero for forward playback or duration for negative speed. |
| `speed` | Finite native time scale; defaults to 1. Negative values play backward; zero freezes native time independently of the pause flag. |
| `weight` | Native blend contribution in [0, 1], default 1. Does not rescale the compiled samples. |
| `blendMode` | `"normal"` (default) or `"additive"`, forwarded to native blending. Rust does not combine samples or derive additive reference poses. |
| `loop` | `{mode: "once" | "repeat" | "pingPong", count?: number | null}`. Count is native repetitions, not a Rust-maintained iteration counter. Once normalizes to count 1; looping modes use null/omitted for infinity or a positive integer. |
| `finalPose` | `"release"` (default) or `"hold"`. Completion with hold settles the request but retains native resources until release. |

Zero-duration clips support once playback, including a held pose. Looping a
zero-duration clip is rejected. Only native notification completes a zero-duration
request; a connector must define and cover its native zero-duration behavior.

`control(handle, controlJson)` accepts discriminated commands:

- `{"type":"pause"}`, `{"type":"resume"}`, `{"type":"stop"}`;
- `{"type":"seek","seconds":0.5}` within the clip's duration;
- `{"type":"setSpeed","speed":2}` or `{"type":"setWeight","weight":0.5}`;
- `{"type":"setBlendMode","blendMode":"additive"}`;
- `{"type":"setLoop","loop":{"mode":"repeat","count":3}}`;
- `{"type":"setFinalPose","finalPose":"hold"}`.

A completed held handle permits only stop or final-pose release. Starting another
play returns a new handle; resuming a settled request cannot create a second
completion. Unknown options/controls and invalid values are rejected, rather
than silently accepted as ineffective controls.

The output commands are `{type:"play", handle, binding:{modelKey,profileKey},
clip, settings}`, `{type:"control", handle, control}` and `{type:"release",
handle}`. Settings contain normalized playback options without `replace`.
Release must stop and free the action and its owned clip resources, detach
callbacks and cancel pending native materialization.

Native input is `{type:"completed",handle}`, `{type:"cancelled",handle}` or
`{type:"error",handle,message}` with a nonempty message. Output terminal events
use the same shapes, with cancellation `reason` identifying `stopped`, `replaced`,
`rebound`, `disposed` or `native`. Obsolete notifications return an empty batch.
An error or cancellation after held completion releases the resource without
emitting a second terminal outcome.

### Dispatch and resource ownership

The connector must execute each returned batch in order before admitting the
next external operation. Deliver terminal events after applying that batch's
resource commands. Native callbacks raised during command execution must be
queued until the batch finishes, then passed to `notify` and processed through
the same ordering. Do not retain an old play batch across a rebind/dispose and
execute it afterward. The Rust session cannot undo native commands a connector
has reordered or discarded.

Native resource allocation belongs to the connector. A failed native operation
must release partially allocated resources and report an `error` notification
for the same handle; do not turn it into a successful start. Release is
idempotent, including when allocation failed before an action existed. Dispose
the session, apply its release commands, detach native listeners and release
connector resources before freeing the Wasm object. Generated `free()` alone
does not operate on native objects.

A failure to release an already settled handle must surface as a connector
cleanup failure to its caller/owner. Retain ownership of unreleased resources
until cleanup succeeds; do not swallow the failure or rely on an ignored late
`notify(error)` to report it. Settling a request and freeing its native resources
are separate obligations.

The session invalidates handle identities on every successful `rebind`, including
identical model/profile keys. Validate and prepare replacement bindings before
committing them in the connector; once committed, old native callbacks cannot
address the new generation. Native events are facts, not duration estimates.
Without a native event, a paused host does not cause a request to complete.

## Native execution and rendering

The Three connector is not implemented by this contract slice. It must translate
commands into native `AnimationClip`/`AnimationAction` operations, forward native
completion, and release action/clip caches. Held completed poses retain their
native resource until released, without receiving a second terminal event.

Connect mixer advancement to the existing rendering integration inside Embody.
Three.js supplies the timing; advance each native mixer exactly once per render
step and suspend with that integration. Expose action commands, not an
`engine.update(dt)` API to Polymer or LoomLarge. Do not add a second clock, RAF,
interval, fallback animation timer, custom fade/release loop, per-frame pose override or
wall-clock completion deadline. Public commands alone do not advance a mixer.
The existing character editor/preview, R3F and embed render paths require
explicit connector integration before Polymer's runtime and its external
`update` callers can be deleted. Existing calls are migration sites, not a
reason to preserve a custom animation driver.
