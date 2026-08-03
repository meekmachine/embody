# Body Orientation Controls

Embody exposes torso orientation as semantic typed snippet channels. Callers
request a direction; the active profile decides which bones, axes, signs, and
ranges realize it. This keeps character behavior independent from a particular
skeleton.

## CC4 Controls

The CC4 preset currently defines six paired controls. Its composite rotations
are serialized with the preset so the TypeScript adapter and Rust/Wasm core
compile the same distributed spine motion:

| ID | Meaning |
| --- | --- |
| 104 | yaw left |
| 105 | yaw right |
| 106 | pitch forward |
| 107 | pitch back |
| 108 | roll/lean left |
| 109 | roll/lean right |

They use the `bodyOrientation` target namespace rather than `au`, because body
orientation is not a Facial Action Coding System action unit. The CC4 profile
distributes each control across `Spine01` and `Spine02` through ordinary profile
bone bindings and composite rotations.

```ts
const snippet = {
  name: 'body-follow',
  channels: [{
    target: { type: 'bodyOrientation', id: 104 },
    keyframes: [
      { time: 0, intensity: 0, inherit: true },
      { time: 0.6, intensity: 0.45 },
    ],
  }],
};
```

The inherited first frame captures the currently mixed pose so a new gaze or
gesture request does not snap the spine back to its rest transform.

## Another Rig

A custom profile uses the same six control ids and supplies its own entries in
`auToBones` plus matching `compositeRotations`. A rig can use one chest joint or
several spine joints; the caller and animation agency do not change. Do not use
typed `bone` channels for portable character behavior, because those channels
make the caller responsible for rig-specific node and axis details.

The current profile schema stores all numeric bone-backed controls in
`auToBones` for compatibility. The target namespace preserves their actual
meaning until the canonical profile-control schema tracked by issue #30 replaces
that legacy field.
