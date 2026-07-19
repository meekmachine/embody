# Humanoid Template Skinning TDR

## Status

Proposed. Documentation and research slice only.

## Context

The current humanoid template work can analyze mesh proportions and solve a
uniform scale plus translation for placing a template skeleton inside a mesh.
That placement is useful, but it is not enough to make a mesh animation-ready.

Rigging also requires rest-pose world transforms, inverse bind matrices, vertex
bone indices, normalized skin weights, and enough mesh structure to distinguish
nearby body parts. Without those outputs, a fitted skeleton is only a positioned
control structure.

## Decision

Do not describe template fitting as automatic rigging. Keep the current Rust/Wasm
helpers focused on host-neutral skeleton placement and confidence signals.

Automatic skin binding should begin as offline authoring research with fixtures,
visual review, and manual escape hatches. The recommended path is:

1. Prefer topology-constrained weight transfer for known humanoid templates.
2. Prototype voxel, geodesic, or heat-diffusion binding for generic mesh-only
   imports.
3. Use bone envelopes or nearest-bone assignment only as a fallback and baseline.
4. Preserve import/export paths for external DCC or rigging tools.

Runtime Wasm can later host proven deterministic kernels, but the first complete
binding workflow should not be a runtime-only feature.

## Why Template Fitting Is Not Rigging

Template fitting answers "where should the skeleton be?" Rigging answers "which
vertices should each bone deform, and how strongly?"

A good skeleton fit can still produce unusable weights when limbs are close
together, clothing bridges body parts, hair or accessories are present, the mesh
is not in a clean rest pose, topology is disconnected, or generated proportions
do not match local anatomy. Bad weights are worse than missing weights because
they create visible stretching, collapsing joints, and cross-limb pulling during
ordinary animation.

## Candidate Approaches

### Bone Envelopes Or Nearest Bone

Assign vertices to the closest bone segment, capsule, or authored envelope, then
smooth and normalize influences.

This is simple, fast, and useful for diagnostics. It also fails visibly around
shoulders, hips, hands, nearby limbs, layered clothing, and face or hair meshes
because world-space distance does not imply deformation ownership.

Verdict: keep as a preview, fallback, and quality baseline. Do not use as the
default production binder.

### Heat Diffusion, Geodesic, Or Voxel Binding

Treat bones as sources and solve influence fields through mesh connectivity,
geodesic distance, or a voxelized volume. Prune, smooth, and normalize the
strongest influences per vertex.

This is the strongest generic automatic-binding research track because it can
respect separation better than raw distance. The cost is complexity: it needs
robust topology or spatial acceleration, can fail on open or layered meshes, and
may be too expensive for large browser-runtime assets.

Verdict: prototype offline with visual regression fixtures before considering
Wasm integration.

### External Or Offline Rigging

Use Blender, a DCC pipeline, a service, or an offline worker to bind the fitted
skeleton, then import the rigged result.

This is the practical production path for high-quality assets because it allows
manual cleanup and avoids forcing heavy mesh processing into runtime. It adds
workflow dependencies and requires careful format round-tripping for skeleton
names, inverse bind matrices, and weights.

Verdict: support as the production-quality escape hatch while in-app automatic
binding is experimental.

### Topology-Constrained Templates

Require or map generated characters to a known template topology, then transfer
tested weights by vertex index, barycentric projection, or nearest-surface
correspondence.

This gives the clearest quality bar for controlled character families and is
cheap, deterministic, and fixture-friendly. It is less useful for arbitrary mesh
imports and will fail if topology correspondence is poor.

Verdict: preferred path for known LoomLarge humanoid character families.

## Recommendation

Prioritize topology-constrained template transfer for controlled humanoid
characters. In parallel, research an offline voxel/geodesic or heat-diffusion
binder for generic mesh-only imports.

Keep Rust/Wasm focused on proportion analysis, template fit transforms, and small
deterministic geometry utilities only after they pass fixture validation. Do not
ship an automatic skinning UI until fixture and visual tests show acceptable
deformation across body, clothing, and failure cases.

## Rejected Alternatives

- Fitting equals rigging: rejected because fitting omits bind matrices and vertex
  weights.
- Nearest bone as default: rejected because it commonly causes cross-limb and
  joint artifacts.
- Runtime-only Wasm first: rejected because robust binding needs expensive
  processing and visual review.
- External service only: rejected because local, reproducible, and private
  authoring workflows still matter.
- UI before quality gates: rejected because bad skinning can make assets look
  less usable than unrigged meshes.

## Failure Modes

- Cross-limb bleed between thighs, arms and torso, or adjacent fingers.
- Joint collapse at shoulders, elbows, wrists, hips, knees, ankles, neck, or jaw.
- Clothing captured by the wrong limb or overfit to the body underneath.
- Rigid accessories receiving soft body weights.
- Hair, eyes, lips, jaw, tongue, or eyelids inheriting generic body weights.
- Non-neutral rest poses producing weights that only look correct in one pose.
- Scale, axis, or rest-transform mistakes that pass bind-pose inspection but fail
  during animation.
- Non-manifold, open, disconnected, or hidden duplicate surfaces confusing
  topology-aware solvers.

## Fixture And Visual Test Bar

Minimum fixtures:

- clean known-topology humanoid with expected transferred weights
- generic watertight humanoid in A-pose or T-pose
- close-limb fixture for thighs, arms, and fingers
- clothed fixture with long sleeves plus skirt or coat
- stylized-proportion fixture with large head or short limbs
- disconnected rigid accessories such as glasses, hat, or handheld prop
- negative non-humanoid or too-low-geometry fixture

Minimum visual checks:

- bind-pose skeleton overlay
- per-bone weight heatmaps
- canned pose set for major joints, neck, and jaw
- comparison against a known-good rig where available
- screenshot artifacts for regression review

Acceptance bar:

- no obvious cross-limb pulling in canned poses
- major joints bend without severe collapse or spikes
- weights are normalized and capped to the host-supported influence count
- rigid accessories are excluded, rigidly attached, or flagged for manual handling
- failures produce warnings and do not silently mark the mesh as rigged

## Open Questions

- Which LoomLarge character families can be constrained to known topology?
- What offline processing time and vertex-count limits are acceptable?
- Should clothing bind with the body, transfer from a body proxy, or use separate
  garment handling?
- What metadata identifies rigid accessories versus deforming meshes?
- Which formats must round-trip bind matrices, joints, and weights?
- How much manual weight editing belongs in the authoring workflow?
- Should face, eyes, jaw, tongue, and hair be excluded from generic body binding
  and handled by specialized presets?
