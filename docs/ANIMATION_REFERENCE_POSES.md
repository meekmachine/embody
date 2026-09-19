# Animation reference-pose foundations

This is the first foundation for reliable imported animation retargeting,
motivated by [LoomLarge#892](https://github.com/meekmachine/LoomLarge/pull/892).
It supplies explicit reference-pose data and preserves standard step/linear clip
interpolation. It does **not** retarget clips, infer bind poses, or enable new
rig combinations in the application.

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
pose: extracting/validating bind or authored reference data from import formats
is subsequent work. A reference is also distinct from an inherited playback
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
a portable animation binding. A future import asset contract must carry stable
binding metadata and validate the target rig when loading.

## Clip conversion fidelity

`serializeAnimationClips` and `createAnimationClipFromClipIR` preserve standard
step and linear interpolation. A step key holds until the next key rather than
blending toward it. Quaternion key values retain their authored starting pose;
conversion does not rebase them against the current model or frame zero. Source
clips and input ClipIR are not mutated.

This does not promise lossless conversion of every Three track. Existing
unsupported targets can be omitted, and smooth/custom interpolants are not
represented losslessly by the current serializer. Diagnostic/strict conversion
and a portable persistence format remain separate work. The host mixer continues
to own playback, interpolation, looping and blending.

## Subsequent work

1. Select supported source/target rig fixtures (initially same-rig and Mixamo/CC4)
   and identify each asset's explicit source and target reference poses.
2. Evaluate Three's `SkeletonUtils.retargetClip` against those fixtures before
   choosing the reusable conversion implementation.
3. Add renderer-neutral pose conversion, explicit mapping, parent-space/basis
   handling and root-motion options in Embody; keep Three extraction at the edge.
4. Integrate through Polymer's existing Animation agency, then replace the
   application-local importer in LoomLarge. Each downstream PR targets its own
   main and consumes a tested immutable upstream preview package.

`node scripts/smoke/reference-pose.mjs`,
`node scripts/smoke/inherited-starts.mjs`, and
`node scripts/smoke/clip-interpolation.mjs` consume the existing package build.
They cover reference and morph immutability, authored Euler turns, strict binding, append-only skeleton
extension beneath posed parents, profile reinspection during playback, inherited
replay starts from the live pose, and actual mixer sampling of step/linear
scalar, vector and quaternion tracks. They never rebuild the package.
