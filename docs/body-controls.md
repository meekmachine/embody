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

Use `setAU`, `transitionAU` and `setContinuum` to control authored outputs.
Intensity drives mapped joints; `setAUMixWeight` adjusts mapped morph contribution
without weakening bone output. Bilateral balance is -1 character-left, 0 both,
+1 character-right. Explicit empty mesh selections remain authoritative and do
not fall back to unselected skin/clothing targets.

`buildClip` and `playSnippet` accept numeric AU curves. `balanceMap` and
`mixWeights` override compilation settings per AU without changing live controls
or saved profile defaults. The same compiler emits all saved bone and morph
outputs. Native playback owns timing, interpolation, cancellation and blending.

Reset controls by setting the selected mapped AU IDs to zero. There is no
separate Body reset owner or cached list of named-control action IDs.

Humanoid role assignment still resolves through `boneNodes`, including authored
exact bone selections. Clearing a role disables its anatomical aliases rather
than falling back to similarly named raw model bones. Reference poses and
composite axes remain part of the existing AU evaluator.

## Persisted record migration

The active `bodyControls` schema and named semantic pose/animation APIs are
removed. Old profile metadata is discarded on library read/export; storage
readers should decode old named poses and animation tracks into numeric AU data
before calling Embody. Prefer mappings stored with that record. The deprecated
`LEGACY_BODY_CONTROL_AUS` export is one reader-only historical CC4 identity
snapshot for records lacking their original catalog. It is not an active control
source and must not be used to assign new meanings or new action IDs. Unknown
legacy names require an explicit migration error.
