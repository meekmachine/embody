# Animation reference-pose foundations

Reference capture supplies explicit reference data and preserves step/linear
clip interpolation. It was introduced for
[LoomLarge#892](https://github.com/meekmachine/LoomLarge/pull/892).
The separate VRM Animation APIs below use these references for bounded body
retargeting. Ordinary capture and ClipIR conversion keep their existing behavior.

## Reference pose versus the current rendered pose

The first animation key is an authored pose, not necessarily the rig's rest or
bind pose. Similarly, a bone's current quaternion can already include playback,
live controls, or an editor adjustment. Neither is an implicit reference pose.

Capture a model only while it is intentionally in the desired reference pose:

```ts
import {
  captureModelReferencePose,
  ThreeModelInspector,
} from '@lovelace_lol/embody/three';

// The caller establishes the reference pose, before any playback or live controls.
const referencePose = captureModelReferencePose(model);
const inspector = new ThreeModelInspector();
const initial = inspector.inspectModel(model, { profile, referencePose });

// Reuse the SAME capture when reinspecting after animation or profile changes.
const later = inspector.inspectModel(model, { profile: editedProfile, referencePose });
// initial/later descriptor restTransform and bone base transforms use the capture.
// Their object bindings still refer to the current scene objects.
```

Capture is explicit and has no hidden cache. Calling capture again samples the
current pose again. This API cannot establish that a loaded FBX pose is a bind
pose. The separate Mixamo adapter reads skin bind inverses or accepts an explicit
authored reference. A reference is also distinct from an inherited playback
start, which intentionally reads the current rendered property before playing.

Without `referencePose`, `inspectModel` retains its existing current-pose
behavior. Only transform reference data changes when the option is supplied;
morph influences, visibility, meshes, and other inspection data remain live.
Snapshot nodes also retain an optional frozen `morphInfluences` array when the
object supplied `morphTargetInfluences` at capture time. Hosts can use this
baseline when binding an already-posed model to a new runtime. It does not alter
inspection's live morph values or inherited playback starts. Missing influence
properties stay absent, empty arrays stay empty, and non-finite values reject
capture. Later morph authoring does not change this baseline automatically.

## Hierarchy and identity

The frozen snapshot retains every object, including non-bone parents, with
structural child-index paths, parent paths, local transforms and complete local
and world matrices. Exact matrices preserve information such as shear that a
decomposed position/quaternion/scale cannot fully express. World matrices remain
in the coordinate frame captured at that time; they are not recomputed from a
later scene placement.
For automatic TRS objects, the optional frozen `rotationEuler` triplet preserves
the authored Euler values with `rotationOrder`, including angles beyond one full
turn. This matters when a host scales native Euler animation values by intensity:
equivalent quaternions alone cannot preserve that authored curve. Inspection uses
these values for `baseEuler`; manual-matrix and older snapshots without the field
fall back to decomposition of the captured quaternion.
Non-finite transforms and manual matrices whose TRS decomposition is non-finite
are rejected; this includes singular manual matrices with undefined rotation.

Binding a snapshot validates structural paths, names and object kinds. A
structurally matching fresh clone can bind without reusing runtime UUIDs.
Hierarchy changes that alter those structural checks must be reconciled
explicitly rather than silently capturing new reference transforms. Swapping
indistinguishable sibling subtrees cannot be detected by these checks: callers
must preserve child order. Structural compatibility is **not** evidence that two
independently authored rigs have the
same reference pose, units, axes, or skinning. This is not a general retarget map.

For an intentional append-only change, such as adding a generated template
skeleton, extend the snapshot explicitly:

```ts
import { extendModelReferencePose } from '@lovelace_lol/embody/three';

model.add(templateSkeleton); // New children must follow every existing child.
const extendedReference = extendModelReferencePose(model, referencePose);
const withSkeleton = inspector.inspectModel(model, { referencePose: extendedReference });
```

Extension preserves all captured data for existing objects, including morph
baselines, and updates only their child counts. New subtrees use their current
local transforms beneath the **captured** parent's world matrix, so movement of
the parent, model root, or surrounding scene does not change the reference.
The caller must establish the intended local reference transforms of new nodes
before extending. Existing paths, names, object kinds, and child order must still
match; deletion, reordering, renaming, and insertion before existing children are
rejected. The original snapshot and scene remain unchanged. The result is deeply
frozen and can bind a structurally matching clone. Ordinary binding remains
strict and never extends a snapshot implicitly.

The existing `ClipIR` numeric bindings remain inspection-local and materialized
Three tracks still use runtime UUIDs. Do not persist those identifiers alone as
a portable animation binding. The VRM Animation path below persists standard
humanoid roles and validates the target rig when loading.

## Clip conversion fidelity

`serializeAnimationClips` and `createAnimationClipFromClipIR` preserve standard
step and linear interpolation. A step key holds until the next key rather than
blending toward it. Quaternion key values retain their authored starting pose;
conversion does not rebase them against the current model or frame zero. Source
clips and input ClipIR are not mutated.

This does not promise lossless conversion of every Three track. Existing
unsupported targets can be omitted, and smooth/custom interpolants are not
represented losslessly by the current serializer. The VRMA path below is a
separate strict conversion API. The host mixer continues
to own playback, interpolation, looping and blending.

## Mixamo FBX and VRM Animation body interchange

`convertMixamoToVrmAnimation(source, clip, options)` converts borrowed Three
objects to standard `.vrma` GLB bytes. Await `initEmbodyCore()` first.
`metersPerUnit` is required: use `0.01` for a centimeter export, or `1` for meters.
Units are never inferred from character size. The source reference comes from
`SkinnedMesh.skeleton.boneInverses`, checked for consistency across skins.
All source bones must have bind inverses. Alternatively supply `referencePose`
explicitly, including for animation-only or parented sources. Neither the first
key nor a currently playing pose is an implicit reference.

`convertMixamoFbxToVrmAnimations(arrayBuffer, { metersPerUnit })` parses FBX
and returns `{ name, bytes }[]`, one standalone VRMA per clip. Skinned exports
use bind inverses. For animation-only exports, the pristine FBX-authored default
transforms serve as the explicit reference; Rust rejects references outside the
supported T-pose. The browser adapter suppresses texture loading, disallows
external resource requests and releases temporary meshes/materials/skeletons/
textures. Input is capped at 64 MiB. Conversion is synchronous and belongs to an
explicit import action, not the render loop; parser resource use still depends
on decompressed content.
Decoded keys are capped at eight million scalar values including timestamps,
before accessor expansion; rigs/tracks at 4096 entries and labels/IDs at 512
UTF-8 bytes. An explicit held clip tail is preserved by extending a final value
to the declared end time because glTF derives duration from its last key.

Rust maps `mixamorigHips`, `mixamorig:Hips` and namespaced Mixamo names to VRM
roles, including fingers. Duplicate aliases reject conversion. It owns hierarchy
validation, quaternion basis conversion, units, hip-height scaling, GLB
encoding/decoding and target-local key generation. Three owns native transform
inspection, FBX parsing and native clip construction.

```ts
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import {
  convertMixamoFbxToVrmAnimations, inspectVrmAnimation,
  createAnimationClipFromVrmAnimation,
} from '@lovelace_lol/embody/three';

await initEmbodyCore();
const [converted] = convertMixamoFbxToVrmAnimations(fbxBytes, { metersPerUnit: 0.01 });
const info = inspectVrmAnimation(converted.bytes);
const clip = createAnimationClipFromVrmAnimation(converted.bytes, model, {
  metersPerUnit: 1,
  referencePose, // explicit target T reference, captured before playback
  profile,       // effective humanoidCharacterization and boneNodes
  name: info.name,
});
mixer.clipAction(clip).play();
```

An explicit `humanoidBones: Record<VRMRole, uniqueBoneName>` option overrides
profile lookup. Otherwise the adapter uses Rust's existing
`validate_humanoid_characterization`. Target scene placement is excluded from
reference math. Conversion neither changes the model nor schedules the mixer.

Persist `converted.bytes` as a `.vrma` file. `inspectVrmAnimation(bytes)` returns
the validated intermediate `{ version: 1, name, durationSeconds, rig, tracks }`,
not an alternative file format. Rig nodes have `id`, `name`, `parent`, local
`translation` XYZ, `rotation` XYZW and `scale` XYZ arrays; `humanoidBones` maps VRM
roles to node IDs and `metersPerUnit` declares units. Tracks contain `node`,
`path`, `interpolation`, seconds in `times` and packed numbers in `values`.
The Wasm APIs are:

- `normalize_mixamo_animation(sourceDocumentJson): string`
- `encode_vrma_animation(documentJson): Uint8Array`
- `decode_vrma_animation(bytes): string`
- `retarget_vrma_animation(documentJson, targetRigJson): string`

Files contain glTF 2 GLB with `VRMC_vrm_animation` 1.0, the complete mapped
hierarchy including every required humanoid bone, and embedded float accessors.
Normalized files use meters and identity rest rotations. Conversion follows the
specification's [rest-rotation equations](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/how_to_transform_human_pose.md):
normalize with `W * inverse(L) * key * inverse(W)`; retarget with
`L * inverse(W) * normalized * W`. Hips displacement is transformed through the
parent reference space and scaled by target/source reference hip height in
meters, retaining target reference hips position as its origin.

### Supported inputs and limits

The body subset preserves linear/step humanoid rotations and hips translation.
Constant non-hips translation/scale tracks equal to the reference may be removed;
changing ones reject conversion. Unknown animated bones also reject. References
must be coherent VRM T-poses: +Y up, +Z forward, character-left +X; arm and leg
segments must be within 20 degrees of their expected axes. A CC4 or other model
captured in an A-pose needs an authored T reference first. Arbitrary anatomical
bases and deformation correction are not inferred.

The reader accepts one animation, embedded packed dense float accessors and
explicit node TRS. It rejects external/multiple buffers, sparse/interleaved data,
cubic interpolation, node matrices, unknown required extensions, malformed keys,
nonunit quaternions, duplicate/cyclic/missing bindings, nonuniform scales, shear
and reflections. This is a subset of
[VRM Animation 1.0](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm_animation-1.0/README.md),
not a claim to accept every conformant file. Expressions, LookAt and eye tracks
are rejected. Existing AU/viseme/morph snippets and semantic action-space controls
remain separate; joint rotations are not inferred `body.elbowFlex` intensities.

An animated optional role absent from the target rejects with its role name.
Folding motion into descendants requires curve resampling, which this path does
not implement. It also does not implement IK, foot locking, root-motion
extraction or collision correction. Required roles must exist even for a
single-bone clip.

Rust test source covers basis conversion, unit/height scaling, binary round trips
and invalid inputs. Three test source covers GLTFLoader intake, host mixer
sampling, profile resolution, reference reuse and FBX temporary-resource
cleanup. These are CI checks, not evidence of real Mixamo/CC4 asset or browser
validation. Polymer integrates these APIs through its Animation agency and must
consume a published immutable Embody package. LoomLarge owns import/export
controls, storage and persona association.

`node scripts/smoke/reference-pose.mjs`,
`node scripts/smoke/inherited-starts.mjs`, and
`node scripts/smoke/clip-interpolation.mjs` consume the existing package build.
They cover reference and morph immutability, authored Euler turns, strict binding, append-only skeleton
extension beneath posed parents, profile reinspection during playback, inherited
replay starts from the live pose, and actual mixer sampling of step/linear
scalar, vector and quaternion tracks. They never rebuild the package.
