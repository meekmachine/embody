# Jonathan starting skeleton

`cc4-humanoid.json` is the single runtime skeleton for phase one of
[LoomLarge #483](https://github.com/meekmachine/LoomLarge/issues/483), tracked in
[Embody #110](https://github.com/meekmachine/embody/issues/110). It keeps the existing
`cc4-humanoid` registry ID and `cc4` character-family ID for consumers. Its source is
Jonathan's `Armature` skin, not the CC4 preset JSON.

The file is bundled by TypeScript and embedded by Rust. Loading it needs neither
the source GLB nor an extraction step. It supplies a starting skeleton only;
fitting scans, generating weights, and binding meshes are separate work.

## Source and regeneration

- Source repository/path: `meekmachine/LoomLarge`,
  `frontend/public/characters/jonathan_new.glb`.
- Source SHA-256:
  `0619c8b5e1589823e583c80e24d3f4567cdbc3349907a1569577585cbfdde192`.
- Skin: `Armature`, 101 named joints, root `CC_Base_BoneRoot`.
- Pose: authored default glTF node transforms, before playing any of the embedded
  `Calibration` animation clips. The source default world matrices agree with
  inverted inverse-bind matrices within `1e-6` per matrix component (measured
  maximum `7.531850163555731e-7`), verifying the rest-pose choice for this asset.

From an Embody checkout with `npm ci` complete:

```sh
node scripts/generate-jonathan-skeleton.mjs /path/to/LoomLarge/frontend/public/characters/jonathan_new.glb
node scripts/generate-jonathan-skeleton.mjs /path/to/LoomLarge/frontend/public/characters/jonathan_new.glb --check
```

The development script deliberately accepts only this exact source hash and
asserts its known hierarchy and transform assumptions. It does not expose a
general extraction API. Generalized extraction, multiple templates and format
migration belong to phase two. The existing translation-only extractor is not
used to produce this file and has not gained general rest-pose extraction support.

## Coordinate contract

- Each bone stores local `translation`, quaternion `rotation` in `[x, y, z, w]`
  order, and `scale`, with its parent identified by name. Compose local matrices
  as `T * R * S` and world matrices as `parentWorld * local`.
- Attach the root directly beneath the loaded glTF **scene/model root**. The
  resulting skeleton is right-handed, Y-up, in metres in that model's coordinates.
  Applying a transform to the host model should transform this skeleton with it.
- The source scene contains a non-joint `Armature` parent with uniform scale
  `0.009999999776482582`. This scale is baked into the template root's scale.
  The root's original rotation of approximately −90° around X is preserved.
  Do not add another Armature scale or rotate axes again when reconstructing.
- Descendant TRS values retain the source joint-local coordinates. Their numeric
  translations are largely centimetre-sized; the root scale provides the
  conversion. Joint scale and rotation values are preserved at source precision,
  without quaternion normalization or accumulated TRS decomposition.
- For compatibility with existing translation-only callers, omitted rotation and
  scale default to identity. Every bone in the checked-in file supplies both.

## Verification

The generation/check command serializes and reparses the file, reconstructs its
Three.js bone hierarchy, and compares all 16 world-matrix components for all 101
joints against the independently composed source scene, at tolerance `1e-12`.
The current result is an exact match. It also checks the default/bind pose
agreement and prints hips, both feet, both hands, and head positions.

Rust regression tests pin those source landmarks and the full skeleton bounds;
a synthetic rotated/scaled hierarchy catches the former translation-addition
error. Package smoke tests compare Rust/Wasm bounds with Three.js reconstruction
using the actual published JavaScript data.

The source skeleton's bounds are approximately
`[-0.557861, 0, -0.119023]` to `[0.557865, 1.726530, 0.136018]` metres.
Hand separation is `0.917045725` metres, hips are at Y `1.023364963`,
head at Y `1.647363785`, and feet at Y approximately `0.0592`.
