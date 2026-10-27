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

## Hair response during head retargeting

An inherited first key preserves position, but it cannot carry outgoing spring
velocity into a newly authored impulse. Automatic head response therefore uses
one continuous Rust simulation per `RuntimeCore`. Retargeting, starting, seeking
or fading AU, live-control and imported native head animations does not create
idle, impulse or gravity response clips.

Rust resolves the profile's characterized `head` role and captured local
reference through `get_hair_head_binding_json()`. After all native mixers sample,
the Three adapter supplies `{ boneName, current: [x,y,z,w], reference: [x,y,z,w] }`
and the renderer's elapsed seconds to
`build_hair_response_clip(name, headQuaternionJSON, dtSeconds, optionsJSON)`.
A missing head role supplies JSON `null`; configured idle sway and wind still
run. There is no hardcoded head-bone fallback. The response measures local yaw
and pitch relative to the captured reference; it does not model parent/world
motion, roll inertia, hair strands or collisions.

Synchronous binding/configuration creates output with a null head and zero
delta. The first fully mixed renderer observation primes head history, so
restoring held live controls during rebinding is not mistaken for new motion.

The simulation retains sway position/velocity, smoothed gravity pitch/velocity,
previous observed head angles and ambient phase. Inertia uses observed angular
velocity; stiffness and damping control a unit-mass spring. Saved direction
signs, gravity, idle sway, wind and response scale feed this same state. Stable
implicit steps are at most 1/120 second. Gaps over 250 ms re-prime head history,
suppress unobserved head inertia, and settle existing momentum for at most
250 ms. A zero delta does not advance dynamics or consume an already primed
head observation. Global mixer speed scales elapsed time; reverse playback uses
its elapsed magnitude and the actual reversed pose, while zero speed freezes it.

Output is constant two-key ClipIR at times `[0, 1]`, containing additive morph
offsets with zero as neutral, including zero-valued mapped channels. It never
registers animation sources or changes live AU/viseme/morph controls. The Three
adapter edits samples on one looping native `__embody_hair_response` action;
its identity and native playback progress survive head retargets and numerical
tuning. The next ordinary native frame applies those samples: this intentionally
adds one frame of response latency. There is no extra mixer update, independent
clock or direct post-mixer morph overwrite.

`pauseAllAnimations()` freezes the response; pausing only a head request lets
hair continue settling. Rust retains physical pause intent even when output
mappings are empty or physics is disabled. Resume re-primes head observation
while preserving momentum and ambient phase. Mapping edits still reconcile and
release native bindings while paused and preserve pause on a replacement action. `stopAllAnimations()`
stops authored animation while physical hair keeps settling, like retained live
controls. `stop()` suspends the renderer binding. Numerical configuration edits
preserve dynamics and ambient phase. Disablement releases output and clears
state; re-enable primes the current head without an initial velocity spike.
Hair-object registration, profile/model rebinding and disposal reset/release the
corresponding simulation and native resources.

`playHairImpulse(horizontal, vertical)` now injects bounded finite velocity into
that same Rust state. It returns `undefined`; there is no independent impulse
handle to pause or replace. Invalid pairs reject before mutation. The public
legacy `build_hair_idle_curves`, `build_hair_impulse_curves` and gravity builders
remain available for deliberately authored clips. `idleClipDuration` and
`impulseClipDuration` apply only to those helpers, not automatic physics.

Rust and native-adapter regression source covers continuity, actual pose input,
configuration and lifecycle behavior for CI. Product acceptance still requires
the matching compiled Embody package adopted through Polymer and LoomLarge;
source changes alone do not update an installed host.

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

The host samples each AU's current contribution and passes the samples,
destinations and any unfinished predecessor travel to the Rust core
(`RuntimeCore.measure_au_travel`), which owns continuum pairing. The remaining
distance is the maximum absolute difference across the goal's movements. Each
AU is its own movement, except that a goal containing both AUs of
a profile `continuumPairs` entry (for example head yaw 51/52) is measured as one
signed continuum, `positive - negative`, which is how composite rotations render
the pair. Crossing neutral from 0.3 negative to 0.3 positive is therefore 0.6
units rather than the 0.3 change of either AU alone, so `unitsPerSecond` gives
the same rendered speed on both sides of neutral. Reversal is likewise judged on
that signed continuum. Unpaired or one-sided AUs keep per-AU distance. The duration is
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
