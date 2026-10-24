# Inherited clip starts

The first curve/keyframe can specify `inherit: true`. Rust preserves this as
`inheritStart: true` on the concrete ClipIR track. Its first numeric value is a
placeholder: `createAnimationClipFromClipIR` replaces it with the current bound
Three property when it creates the AnimationClip. Remaining authored samples,
their scaling, and timestamps stay unchanged. Only the first key's flag matters.
An inherited track is retained even when its effective intensity scale is zero,
so it can release a nonzero current pose toward zero.

This applies to AU, viseme and named-morph snippet tracks, generic curve targets,
and explicitly authored morph, bone/object transform and visibility tracks.
At the low-level `createAnimationClipFromClipIR` boundary, the inherited value
is the rendered local property, including other animations' contributions.
The `Embody` host's additive same-name replacement instead samples that request's
own native track contribution; another animation's mixed output must not become
part of its inherited start. Without a predecessor, its own additive contribution
starts at the captured reference. Neither path reads a semantic control's cached
live value as the current rendered pose.

## Playback and replay contract

Cache ClipIR. Materialize a new Three clip immediately before **every** new play,
replay or utterance replacement, while the outgoing visible pose is still on the
model. Conversion does not mutate ClipIR or any earlier Three clip.

```ts
const clip = createAnimationClipFromClipIR(cachedClipIR, inspection);
const action = mixer.clipAction(clip);
action.play();
// The host owns stopping/fading and uncacheClip(clip) when no longer in use.
```

A materialized Three clip is a snapshot. Reusing its action with `reset().play()`
reuses the old inherited value. A host that caches Three clips at registration
must retain ClipIR and convert it again at playback; simply updating this package
does not repair that host's cached replay path. Resume, seek and loop cycles on
an existing action retain the same captured start rather than sampling again.

## Delayed first keys

Timestamps are not rewritten. If the inherited first key is at 0.5 seconds, its
captured value holds from playback start through 0.5 seconds, then interpolates
to the next key. This preserves Loom3 and Three sampling behavior. Author the
inherited key at `time: 0` when interpolation should begin immediately. A
single inherited key holds the captured value for the clip's entire duration.

## Remaining semantic bone work

Generated composite bone, translation and automatic viseme-jaw tracks carry an
inherited first-sample flag. For a two-key goal with shared timestamps, native
inheritance and interpolation preserve the complete compiled bone/morph output.
General multi-key curves with different timestamps still require care: replacing
only the first generated sample does not recompute intermediate dependencies.
The distance-timing capability below deliberately accepts only two-key numeric
AU goals; it does not claim general inherited semantic-curve parity.

## Distance-based AU admission

`Embody.animationCapabilities` is a frozen read-only capability object containing
`distanceTiming: true`. `CharacterPlaybackOptions.distanceTiming` accepts
`{ unitsPerSecond, minimumDurationSec?, reversalExtraSec? }`. Speed must be finite
and positive; optional durations must be finite and nonnegative and default to
zero. Durations must remain representable as finite positive native Float32
keyframe times. Unsupported/unknown timing fields reject before native replacement.

The source must contain canonical numeric AU IDs and exactly two keys per AU:
an inherited placeholder at zero, and a destination at nominal one second. The
host creates immutable scalar `NumberKeyframeTrack` measurement metadata on the
existing native `Playback`. At the next admission, its interpolant evaluates the
actual predecessor action's native time once. It has no separate clock, frame
update, changing pose cache, rig mapping or independent request ledger. Rust
continues compiling semantic AUs to every configured bone and morph track.
Even cleared mappings retain their requested semantic timing without invented
rig outputs or writes to live AU state.

The remaining distance is the maximum absolute AU difference. The duration is
`max(distance / unitsPerSecond, minimumDurationSec)`, plus `reversalExtraSec`
only when an unfinished predecessor changes direction. A held completed action
has no reversal penalty. Zero distance uses a `1e-6` second microhold, bypassing
both duration floors. Scalar endpoints and durations use the native Float32
representation so an identical nonzero held endpoint remains zero-distance.
This fresh clip's key times are scaled once; Three's native action owns all
subsequent interpolation and playback. Global native mixer time scaling still
affects wall-clock travel, as it does for other clips.

Initial support is linear, additive, once-only playback, with unit native
speed/weight, no fade, zero start offset and no explicit additive reference.
The requested source `intensityScale` scales only destination values; inherited
starts remain the outgoing request's own contribution. A same-name predecessor
must have this measurement basis, the same AU keys, balance/mesh bindings and
effective morph mix weights. Explicit clip mix weights override authoritative
Rust live/saved defaults. If those effective defaults change, inheritance rejects
instead of treating incompatible physical contributions as the same AU basis.
No general inverse from a quaternion/morph pose to AU values is assumed.

FBX/native sources, typed channels, noncanonical aliases, unrelated predecessors
and nonlinear easing reject `distanceTiming`. Linear interpolation gives this
option its AU/s meaning; easing must not silently turn it into a nominal playback
multiplier. The ordinary playback APIs continue supporting their existing inputs
when this option is absent.

`buildClip` prepares/registers the authored nominal source without starting a
native action. Timing is resolved when `.play()` admits it, using then-current
native progress. Pause/resume/seek keep native ownership. Fresh play and completed
held resume remeasure and start at zero instead of replaying a prior seek offset.
Stop, rebinding and disposal retire the predecessor and its metadata together;
an obsolete prepared handle cannot admit work after binding replacement.
In-place timing/strength/balance/mix/easing/native-speed edits reject atomically:
send a fresh ordinary goal instead. Existing seek and final-pose controls remain
available. Immediate play validates duration representability before compiling
or replacing the named source, preserving previous native work on failure.

Package regression source in `scripts/test/character-adapter-contract.test.mjs`
covers these boundaries for CI, including custom composite mappings and separate
additive playback. No browser/rig acceptance or released host integration is
implied by this library capability.

`node scripts/smoke/inherited-starts.mjs` tests the compiled Wasm and actual Three
mixer, including replay from a changed pose, delayed keys, fixed starts, scaled
endpoints, and transform interpolation. Run `npm run build` first; the smoke test
does not rebuild the package.
