# Body controls

Body controls reuse FACS action evaluation: one numeric action drives
`auToBones` and `auToMorphs`, with the existing bilateral balance, morph mix,
composite rotations and continuum pairs. VRM supplies anatomical role names;
control names such as `body.elbowFlex` are Embody profile vocabulary.

The CC4 preset includes **58 motion controls covering all 55 VRM 1.0 bone roles**.
Torso and pelvis controls provide bend, twist and side bend. Arms expose shoulder
raise/swing, upper-arm swing/spread/twist, elbow flex and forearm rotation.
Hands expose wrist bend/deviation, all 15 finger-segment curls per side and
spread for each finger. Legs/feet expose hip swing/spread/twist, knee bend,
ankle bend, foot tilt and toes. Head/eyes/jaw reuse existing facial actions.
Bilateral controls expose independent left/right balance; signed motions use
continuum pairs. This catalog is authored CC4 motion data, not a VRM-defined
motion vocabulary or a motion generator for arbitrary imported rigs.

Original IDs remain stable: elbow flex (1001), knee bend (1002), and torso twist
(negative 1003, positive 1004). Added body actions use 1010–1090. These are not standardized FACS AUs.
`profile.getBodyControls` returns sorted descriptors for the Body drawer;
an optional model descriptor enables missing-bone and missing-morph diagnostics.

```json
{
  "bodyControls": {
    "body.elbowFlex": { "label": "My biceps" }
  },
  "auToMorphs": {
    "1001": {
      "left": ["My_Bicep_L", "Shirt_Clearance_L"],
      "right": ["My_Bicep_R", "Shirt_Clearance_R"],
      "center": []
    }
  },
  "morphToMesh": { "body": ["CC_Base_Body", "Shirt"] }
}
```

This sparse preset override keeps the elbow action ID, bilateral flag and
VRM roles. A `null` control deletes it from the catalog; `negativeAuId: null`
removes the signed-slider association. Numeric action bindings remain explicit
profile data. Existing symmetric `LL_Body_Bicep_Flex` can be assigned to
`center`; it responds to intensity equally regardless of left/right balance.
Independent muscle sides require independently authored left/right targets.

Every catalog action, including both directions of signed controls and the
shared head/eye/jaw actions, accepts independent `auToMorphs` assignments.
Torso, Head, Arms, Hands, Legs and Feet all use the same evaluator. Map each
signed direction by its own action ID; the descriptor's `morphBindings` is an
aggregate for display, not a combined assignment to save back to both actions.
`auMixDefaults` and live morph-strength changes scale Body morphs even if their
bone bindings are missing or cleared. Bone intensity remains unchanged.
To persist removal of inherited targets, save an explicit entry with empty
`left`, `right` and `center` arrays; omitting an action or using `null` retains
preset inheritance. Mapping a target does not create its mesh geometry.

Authored Body target names are resolved only within the action's configured
mesh category, including primitive-name variants. An explicit empty category
list disables its outputs; a missing target cannot silently fall back to an
unselected mesh. A legacy profile with the category entirely omitted retains
content-based fallback. Non-Body actions and visemes keep their existing fallback
behavior. Missing targets are diagnosed and skipped while other available sides
continue to work. Skin and clothing can share an action when both authored
meshes are included in its category.

The complete definition is `{label, section, auId, negativeAuId?, bilateral,
roles, order}`. Bone bindings target a role, for example
`{node: "leftLowerArm", channel: "rx", scale: 1, maxDegrees: 120, side: "left"}`.
The characterization maps that role to a `boneNodes` key. The corresponding
`compositeRotations` entry also targets `leftLowerArm` and includes action 1001
in its pitch group. Signed controls additionally declare `continuumPairs`.
Use `auInfo.facePart: "Body"`, `auFacePartToMeshCategory.Body: "body"` and
`morphToMesh.body` to route body and clothing targets through the same evaluator.

Head and eye controls use the original AU IDs (51–56 and 61–64), so their
facial and semantic editors read and write the same `auToMorphs` and
`auMixDefaults` entries. Neck actions 1032–1037 use the corresponding CC4
head-turn/tilt targets as their initial tissue mappings: back/up 1032→53,
forward/down 1033→54, right turn 1034→52, left turn 1035→51, left tilt
1036→55 and right tilt 1037→56. These are independently editable neck actions,
not aliases that overwrite the head action. Neck `faceArea` remains `Body`,
while `facePart: "Head"` routes these targets through the same face mesh category
as their source head AUs. Bend and tilt start at morph strength 0.7; turning
uses the existing full-strength fallback of 1.0. As with FACS, morph strength
attenuates the tissue target without attenuating bone rotation. Missing authored
targets remain optional and are reported in model-aware descriptors.

`profile.setAUMorphTargets` accepts `{profile, auId, side, targets}` and returns
the edited profile/config. `side` is `left`, `right` or `center`; `targets` is
an array of nonempty morph names or nonnegative integer indices. It replaces
only that action's selected side, retaining other sides, actions, bone bindings
and host metadata. Duplicate targets are removed in order. An empty array is
an explicit clear and survives preset save/reload. Existing nested profile
overrides receive the same complete AU entry. The operation supports a target
shared by several actions; assigning neck tissue does not remove the head's
mapping. An explicit static profile never acquires preset motion defaults.
Polymer must expose this request and the application must provide the semantic
mapping editor; Embody owns the edit and runtime behavior, not that UI.

`bodyControls` merges per control and per field, including nested `profile`
overrides followed by top-level overrides. Expanded configurations contain the
resolved catalog, with deleted entries removed; deleting every control yields
`bodyControls: {}`. Other character configuration metadata is preserved.
Authored body overrides are retained under `profile.bodyControls`, so a later
save/reload and preset expansion preserves deletions without exposing tombstones
to consumers of the resolved top-level catalog.

Existing nonempty facial composite snapshots retain untouched default body
composites; explicit entries for the same body node override them. An explicit
`compositeRotations: []` disables all composite rotations, including facial and
body rotations, through profile expansion, editing and runtime configuration.
Missing or `null` tables retain the legacy preset fallback. Morph bindings
continue to work independently of this table.

`RuntimeCore.get_au_balance(id)` returns the current manual bilateral balance
(zero when unset). It follows `set_au`, signed/continuum controls and transitions,
survives profile reconfiguration alongside AU values, and resets with `clear`.

`humanoid.getSpecification` returns `{standard: "VRMC_vrm-1.0", bones}`. Each
bone has `role`, `label`, `section`, `parent` (nullable), `required`, and
`requiresParent`. It covers all 55 roles, including 15 required roles; 21 roles
require their optional parent (upperChest and the child finger segments).
The canonical metadata follows the [VRM 1.0 humanoid specification](https://github.com/vrm-c/vrm-specification/blob/master/specification/VRMC_vrm-1.0/humanoid.md)
and is tested against its official schema. Validation checks unique resolved
bones, missing roles/required optional parents, nearest mapped semantic ancestry
while allowing non-humanoid intermediary nodes, and positive nonzero rest scales
when the model descriptor supplies scale. It does not certify a complete VRM
asset or infer missing transforms.

CC4 maps Waist → spine, Spine01 → chest and Spine02 → upperChest; every role
has a distinct authored bone. The original torso-twist actions keep their
physical Spine01 target. Unknown or missing optional anatomy is diagnosed;
models do not acquire synthetic bones.

`profile.setHumanoidRoleBinding` accepts `{profile, role, boneName}` with a literal
model bone name or `null` to clear, and returns the edited profile. It preserves
an existing node key and moves matching AU/composite/continuum aliases onto the
semantic role so reassignment and clearing affect actual motion. An authored
`exactBoneName` records the literal selection, avoiding accidental prefix/suffix
matches; changing `boneNodes[nodeKey]` manually invalidates that exact selection.
Cleared roles retain dormant semantic actuator bindings, which cannot fall back
to a similarly named model bone. Reassigning the role reactivates those bindings.
Persist the complete returned profile (including `continuumPairs`). An explicit
empty/static profile stays static: role assignment never seeds CC4 actuators.

`humanoidCharacterization` otherwise remains a complete versioned replacement
contract. The exact previously shipped 17-role CC4 preset snapshot migrates to
55 roles and acquires new axes on older body composites; existing physical
actuators and custom axes remain intact. Custom/partial maps and maps marked
`authored: true` are authoritative and never expanded by this migration. Explicit
`compositeRotations: []` remains authoritative even for migrated snapshots.

CC4 axes were checked against the repository's
`LoomLarge/loomlarge_lol/public/characters/jonathan_bust.glb` rest hierarchy:
forearm +X bends the hands toward model +Z, calf -X bends the feet toward -Z,
and spine Y is vertical. Clavicle/arm local Z uses opposite left/right signs
for bilateral raising, limb local Y supplies axial rotation, fingers curl about
local X, feet tilt about local Y, and ankles/toes bend about local X. New ranges
are conservative authored demonstration ranges (15–60°), not anatomical limits.
Automated tests check every control/direction/balance against the authored
skeleton and verify reset, shared facial actions and optional morph outputs.
Other rigs need their own axis/range calibration. These mappings do not infer
the pose of a scan or generate muscle morph geometry. The default per-side
`LL_Body_Bicep_Flex_L` and `_R` targets are optional until authored or overridden.

## Configured runtime commands and frame ownership

`RuntimeCore.get_body_controls_json()` returns the same model-aware descriptors
as `profile.getBodyControls`, resolved and cached during configuration. Hosts
can render the Body drawer from the configured profile/model without traversing
the renderer scene again. Empty profiles return `[]`; reconfiguration refreshes
availability and missing-target diagnostics.

`RuntimeCore.reset_body_controls()` clears the value and bilateral balance of
each unique action in the configured Body catalog in one command, including
both directions of signed controls. Facial actions also exposed in Body are
included; unrelated face values, visemes, direct morph overrides and morph mix
weights are preserved. The command does not write renderer objects. The host
applies one procedural frame afterward and refreshes its controls.

Synchronous live control writes use `evaluate_procedural_morph_frame()` and
`evaluate_procedural_bone_frame()`. Rust evaluates each channel type once and
tracks which properties it owns. A formerly active property emits its neutral
release once. Untouched properties emit no write, so a constant mixer track
keeps its held value. Bone rotation and position ownership are independent;
explicit direct morph overrides own their target even when their value is zero.
Clearing a direct-only target still emits one zero release although that target
no longer appears in the dense frame. Morph row ordering is deterministic.

After mixer playback, `evaluate_active_morph_frame()` and
`evaluate_active_bone_frame()` remain pure reads of currently active state.
They do not consume pending releases or change procedural ownership. Existing
dense frame queries retain their full neutral-write behavior.

Before replacing renderer bindings, apply `release_procedural_morph_frame()`
through the old applier IDs. It returns zero rows for previous morph ownership
and clears frame tracking. Successful profile/model configuration also resets
tracking, so reused numeric IDs cannot inherit ownership from an old model.
`reset_procedural_frame_tracking()` is available when discarding bindings.
Ordinary `clear()` and `reset_body_controls()` retain tracking until the next
procedural frame releases their channels. Renderer application, mixer playback
and gaze constraint scheduling remain host responsibilities.

Morph previews must end with `release_morph(name, meshNamesJson)` or
`release_morph_index(index, meshNamesJson)`. These remove only matching direct
overrides and report the count removed, using the same mesh selection as their
`set_morph` counterparts. The next procedural frame restores the underlying AU
or viseme value, or releases the target once if no control remains active.
Setting a morph to zero deliberately retains direct ownership and masks AU
output until released; it is not preview cleanup. Other direct overrides,
AU values and morph-strength settings are preserved by a targeted release.

Manual `set_au_signed` / Polymer `setAU` commands select one direction of a
configured continuum pair: a nonzero value clears its opposite, matching
`setContinuum`. A negative value selects the opposite direction; zero releases
only the named action. This prevents opposite head or body tissue morphs from
remaining active after switching sliders. Distinct axes and head/neck actions
remain independent. Raw `set_au` state ingestion and authored clip blending
retain their existing composition semantics.
