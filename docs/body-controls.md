# AU controls and anatomical mappings

Live controls and animation curves use numeric AU IDs and the character's saved
`auInfo`/`actionInfo`, `auToBones`, `auToMorphs`, `compositeRotations` and
`continuumPairs`. VRM humanoid roles identify anatomical targets; they do not
define another motion catalog. Control counts follow actual profile data.

`getAUDescriptors(profile, modelDescriptor?)` and `engine.getAUDescriptors()`
return AU labels and classification, signed continuum pair IDs, actual available
sides, saved `morphStrength`, resolved bone/morph names, binding data and support
diagnostics. The optional model descriptor is renderer-neutral. Profile-only
queries describe configured outputs; model-aware queries identify missing bones
and morphs. `bilateral` indicates side-selectable output even on a partial rig;
`availableSides` reports which requested sides are actually present. A left-only
AU retains its valid negative balance without advertising an absent right side.
There is no `body.*` identity or separate active catalog.

### Categories and anatomical presentation

Each descriptor has a `category`: `au` for facial/FACS controls, `body` for
semantic skeletal movements, `bone` for authored direct joint-axis controls,
or `custom` for other profile-defined controls. Visemes retain their separate
slot/binding API. The existing numeric ID remains the input to `setAU` and the
clip compiler in every category; changing presentation never changes its bone
or morph outputs, mesh routing, balance or morph-strength behavior.

Profiles author optional `category`, `section`, `order` and `controlLabel` on
their existing `auInfo` or legacy `actionInfo` entry. `controlLabel` names the
combined movement of a continuum; `name` remains the individual direction's
label. CC4 restores the historical presentation on all 58 movement equivalents:
51 Body movements under Whole body, Torso, Head, Arms, Hands, Legs and Feet,
and seven canonical head/eye/jaw movements in AU/FACS. The latter retain their
existing AU identities and outputs rather than duplicate Body controls. Fish
keeps its own anatomical sections and movements despite sharing numeric IDs
with human profiles.
Body `order` values encode that anatomical section order and preserve the
historical movement order within each section; hosts can sort without a
second rig-specific section list.

The CC4 elbow control is labelled `Elbow flex` and maps the forearm bones by
default. It has no default muscle morph targets. The former
`LL_Body_Bicep_Flex_L`/`_R` entries were example names, not morph geometry supplied
with a CC4 character, and are no longer assigned by the preset. Importing a model
does not implicitly link its muscle shapes to elbow motion. Morphs can be
previewed directly; linking one to a movement requires an explicit character
`auToMorphs` assignment to an existing target. Existing explicit saved mappings
retain their names and missing-target diagnostics; this is a preset correction,
not a filter that deletes character-authored mappings.

Without explicit category metadata, legacy `Joint Controls` entries resolve to
`bone`, legacy Body area/part entries to `body`, Upper/Lower area entries to
`au`, and other entries to `custom`. Numeric ranges and resolved target support
never determine category. Hosts must only combine paired directions when both
descriptors have the same category; profile pairs remain evaluator inputs even
if their presentation categories differ.

`hasConfiguredBones` and `hasConfiguredMorphs` describe authored bindings,
independently of the existing `hasBones`, `hasMorphs` and `available` support
fields. An unavailable configured bone remains in `boneBindings` with diagnostics;
its category and presentation remain intact. Hosts can display that movement
disabled with the cause instead of hiding it. Explicitly cleared bindings have
no configured support even when their metadata retains a visible row.

Preset composition preserves inherited presentation when an older saved metadata
entry omits those fields; saved names and routing retain their existing replacement
semantics. Explicit `null` presentation fields clear inherited values and survive
export/reload. A cleared category resolves to `custom`. Empty `auToBones` arrays,
explicitly empty morph-side arrays and an explicit empty composite rotation
table remain authoritative. A nullable morph-map entry retains the existing
preset-merge semantics; use empty side arrays to clear inherited morph targets.
Sparse custom profiles acquire no CC4 data.
During preset composition, an authored legacy `actionInfo` entry also supplies
its canonical `auInfo` override when that ID has no authored canonical entry.
An explicitly authored `auInfo` key always wins, including its existing null-entry
inheritance behavior. This keeps legacy saved names and presentation effective
without reversing descriptor precedence between the two metadata spellings.
Sparse legacy entries inherit omitted canonical names and routing fields, so a
category-only legacy edit cannot erase existing morph routing or compiler
classification. Authored legacy routing fields remain overrides.

Bone authoring APIs save new joint-axis controls with category `bone`.
`isJointControlAuInfo` follows the resolved category and its legacy fallback.
`buildBoneAuOptions` labels choices as FACS, Body, Bone rotation or Custom and
returns category, section and order alongside its existing option fields.

Each descriptor's `auId` identifies that AU, including a continuum's negative
member. For a paired AU, use `negativeAuId` and `positiveAuId` as the signed
continuum inputs. Reciprocal `continuumPairs` entries report the same direction
IDs from either member's descriptor.

Use `setAU`, `transitionAU` and `setContinuum` to control authored outputs.
Intensity drives mapped joints; `setAUMixWeight` adjusts mapped morph contribution
without weakening bone output. Bilateral balance is -1 character-left, 0 both,
+1 character-right. Explicit empty mesh selections remain authoritative and do
not fall back to unselected skin/clothing targets.

`buildClip` and `playSnippet` accept numeric AU curves. `balanceMap` and
`mixWeights` override compilation settings per AU without changing live controls
or saved profile defaults. The same compiler emits all saved bone and morph
outputs. Native playback owns timing, interpolation, cancellation and blending.

### Live control availability and saved poses

Caller animation actions own their concrete emitted targets until native release,
including paused actions, completed held actions, and actions fading out. Before
writing canonical state, live AU, continuum, viseme, morph, mix-strength, clear,
and transition setters reject intersecting targets with `LiveControlLockedError`
(`code: 'LIVE_CONTROL_LOCKED'`, `availability`). Unrelated targets remain editable.
Internal live transitions and hair actions do not create these caller locks.

`getLiveControlAvailability(query?)` returns `{bindingGeneration, revision,
available, blockers}`. Each blocker contains `{name, actionId, targets,
keepPoseSupported}` from its actual native clip. Queries select an AU, continuum,
viseme, morph, exact bone name/role plus rotation/position/scale property, or
concrete targets. AU queries include both directions of a configured continuum.
`subscribeLiveControlAvailability(listener)` sends an initial snapshot and native
lifecycle changes; unsubscribe is idempotent. Hosts subscribe rather than poll
frames. Old model handles cannot admit playback after rebinding.

`buildPoseClip(name, pose, options)` prepares a native handle without applying
live values; `playPose` prepares and plays it. `CharacterPoseInput` accepts sparse
`aus`, `auBalances`, `auMixWeights`, `morphs`, and `bones`. Raw bones retain local
quaternion or Euler rotation (degrees and explicit order), position and scale.
Rust resolves exact current names/profile roles and rejects unresolved or
ambiguous bindings before native admission. The caller supplies its intended AU
selection and explicit clears; `includeFacialExpression` is metadata rather than
a second target-selection policy. For mapped saved poses, AU-emitted destinations
win over duplicate saved raw outputs; other duplicate raw destinations reject.

A normal saved pose temporarily replaces overlapping internal live native
outputs. Its release restores that live baseline, without restarting unrelated
live transitions. Unrelated edits cannot recreate the baseline under a held pose.
`stopAnimationKeepPose(name)` explicitly releases a transferable action and makes
its pose editable; held completion alone does not release ownership. The result
is `{accepted, reason?}`. Supported cases are isolated, full-weight additive
numeric-AU clips with compatible live mappings, and constant AU-only normal saved
poses whose candidate live outputs Rust proves equivalent to compiled outputs.
Overlapping actions, partial weights/fades, baked or typed sources, raw bone/morph
poses, conflicting live mappings and out-of-range values reject without releasing
the action or changing live state. This API does not infer AU values from arbitrary
rendered tracks. `readAUState().total` remains semantic aggregation, not an inverse
of the final blended rig pose.

Reset controls by setting the selected mapped AU IDs to zero. There is no
separate Body reset owner or cached list of named-control action IDs.

Humanoid role assignment still resolves through `boneNodes`, including authored
exact bone selections. Clearing a role disables its anatomical aliases rather
than falling back to similarly named raw model bones. Reference poses and
composite axes remain part of the existing AU evaluator.

Older CC4 snapshots may contain AU bindings without their classification metadata.
Preset composition uses inherited AU metadata to preserve mapped body rotation
groups alongside saved facial groups. An explicitly empty rotation table still
disables rotations, and authored replacement groups retain their selected AUs.

## Persisted record migration

The active `bodyControls` schema and named semantic pose/animation APIs are
removed. Old profile metadata is discarded on library read/export; storage
readers should decode old named poses and animation tracks into numeric AU data
before calling Embody. Prefer mappings stored with that record. The deprecated
`LEGACY_BODY_CONTROL_AUS` export is one reader-only historical CC4 identity
snapshot for records lacking their original catalog. It is not an active control
source and must not be used to assign new meanings or new action IDs. Unknown
legacy names require an explicit migration error.
