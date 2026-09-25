# Body controls

Body controls reuse FACS action evaluation: one numeric action drives
`auToBones` and `auToMorphs`, with the existing bilateral balance, morph mix,
composite rotations and continuum pairs. VRM supplies anatomical role names;
control names such as `body.elbowFlex` are Embody profile vocabulary.

The CC4 preset includes elbow flex (1001), knee bend (1002), and torso twist
(negative 1003, positive 1004). IDs identify actions, not standardized FACS AUs.
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

The complete definition is `{label, section, auId, negativeAuId?, bilateral,
roles, order}`. Bone bindings target a role, for example
`{node: "leftLowerArm", channel: "rx", scale: 1, maxDegrees: 120, side: "left"}`.
The characterization maps that role to a `boneNodes` key. The corresponding
`compositeRotations` entry also targets `leftLowerArm` and includes action 1001
in its pitch group. Signed controls additionally declare `continuumPairs`.
Use `auInfo.facePart: "Body"`, `auFacePartToMeshCategory.Body: "body"` and
`morphToMesh.body` to route body and clothing targets through the same evaluator.

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

`humanoidCharacterization` remains a complete
versioned replacement contract: supply its schema, standard, status and full
roles map when overriding it, or customize existing `boneNodes` names instead.

CC4 axes were checked against the repository's
`LoomLarge/loomlarge_lol/public/characters/jonathan_bust.glb` rest hierarchy:
forearm +X bends the hands toward model +Z, calf -X bends the feet toward -Z,
and spine Y is vertical. Angles are demonstration ranges, not anatomical limits.
Other rigs need their own axis/range calibration. These mappings do not infer
the pose of a scan or generate muscle morph geometry. The default per-side
`LL_Body_Bicep_Flex_L` and `_R` targets are optional until authored or overridden.
