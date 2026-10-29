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
The inherited value is the rendered local property, including other animations'
contributions, rather than the rest pose or a semantic control's cached value.

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

## Additive replacement and weights

`Embody` playback refines the rendered-pose capture for additive requests.
When a same-name action is replaced, an additive replacement inherits that
slot's **own** previous contribution rather than the mixed pose, so offsets
from other additive clips are not counted twice. Normal-blend replacements keep
the rendered-pose capture above.

Inheritance uses the outgoing action's effective weight. A fading action
contributes value × weight; the incoming start is that contribution expressed
at the incoming action's weight (`outgoing weight / incoming mixerWeight`).
Additive offsets scale toward neutral, and normal samples move toward the
captured reference. Re-acquiring a slot during a fade therefore continues from
the faded pose instead of jumping back to the unfaded track value. Live
controls apply the same rule to each live target's own outgoing action.

## Semantic AU records

For AU-curve sources (`buildClip`/`playSnippet`), Rust also records the clip's
authored AU keys at admission. An inherited first key resolves to the same-name
predecessor's semantic value at its native time, scaled by the same weight
ratio, or zero when there is none. These records are immutable apart from
strength/easing edits and are evaluated only when a host reads them
(`readAUContribution`, `readAUState`, `measureAUGoal`; see the README). They do
not tick, sample frames or drive playback. Viseme and named-morph curves,
typed channels and native clips have no AU identity to record.

The adapter captures the predecessor's native time and weight before replacement
stops its action. A completed held action also releases its resources
synchronously; its semantic record stays available until the new slot is
recorded. Deferred cleanup retires the predecessor without deleting the new
same-name record. Explicit release and replacement by a non-AU source remove
that record normally.

## Delayed first keys

Timestamps are not rewritten. If the inherited first key is at 0.5 seconds, its
captured value holds from playback start through 0.5 seconds, then interpolates
to the next key. This preserves Loom3 and Three sampling behavior. Author the
inherited key at `time: 0` when interpolation should begin immediately. A
single inherited key holds the captured value for the clip's entire duration.

## Remaining semantic bone work

Generated composite bone, translation and automatic viseme-jaw tracks resample
multiple semantic curves before emitting concrete ClipIR. They do not yet carry
inherited semantic inputs. Replacing only the first generated sample would leave
intermediate samples incorrect when the contributing curves have different
timestamps. Full parity requires retaining those dependencies until current
semantic values can be resolved at playback. Explicitly authored concrete bone
and object tracks support inherited starts through the adapter now.

`node scripts/smoke/inherited-starts.mjs` tests the compiled Wasm and actual Three
mixer, including replay from a changed pose, delayed keys, fixed starts, scaled
endpoints, and transform interpolation. Run `npm run build` first; the smoke test
does not rebuild the package.
