# Annotation Configuration

Embody stores annotation configuration in Rust profile `annotationRegions`. The Three adapter exports `resolveAnnotationCharacterConfig(...)` for preset-expanded camera and marker inputs; `ThreeAnnotationController.loadRegions(...)` calls it by default. `AnnotationRuntime` owns camera and marker decisions/state in Rust; `AnnotationLifecycle` owns preview/reveal timing. The `@lovelace_lol/embody/three` adapters inspect native objects, execute native queries and apply Rust results. Await `ThreeAnnotationController.create(...)` or initialize the Wasm core before using synchronous constructors. See the [runtime and migration contract](README.md#annotation-runtime).

There are three related shapes to know about:

1. The canonical Embody preset/profile shape: `annotationRegions`
2. The structural annotation input shape: `AnnotationCharacterConfig`, selected with `profilePresetId`
3. The runtime/legacy mirror for older camera and marker consumers: `config.regions`

## Runtime Extension

New stored records should select the base profile with `profilePresetId` and put reusable overrides on `Profile` fields such as `annotationRegions`:

```ts
import { resolveAnnotationCharacterConfig, type AnnotationCharacterConfig } from '@lovelace_lol/embody/three';

const savedProfile: AnnotationCharacterConfig = {
  characterId: 'jonathan',
  characterName: 'Jonathan',
  modelPath: 'characters/jonathan_new.glb',
  profilePresetId: 'cc4',
  annotationRegions: [
    {
      name: 'left_eye',
      paddingFactor: 0.5,
      cameraAngle: 45,
    },
    {
      name: 'right_eye',
      paddingFactor: 0.5,
      cameraAngle: 315,
    },
  ],
};

const runtimeConfig = await resolveAnnotationCharacterConfig(savedProfile);
```

`runtimeConfig.annotationRegions` and `runtimeConfig.regions` contain the preset regions plus saved overrides. The `regions` mirror exists so older camera and marker tooling can keep consuming top-level region entries while new Embody data stays profile-first.

When you call `resolveAnnotationCharacterConfig(...)`, Embody extends these shapes with this precedence:

1. preset `annotationRegions`
2. top-level profile fields and `annotationRegions` overrides by region name
3. legacy nested `config.profile.annotationRegions` for compatibility
4. top-level `config.regions` only as a fallback when canonical annotation overrides are absent

If canonical annotation overrides exist, legacy `config.regions` entries are only preserved for non-preset extras that do not collide by region name.

`auPresetType` remains accepted for existing records. New annotation consumers can use `AnnotationCharacterConfig`, `profilePresetId`, and `resolveAnnotationCharacterConfig(...)`. App-specific storage and profile normalization can be supplied through the controller’s `resolveCharacterConfig` callback; annotation resolution does not require app code and preserves additional host fields without serializing them to Wasm.

## Embody Profile Shape

Embody itself supports preset-level annotation defaults through `annotationRegions` on `Profile`:

```ts
import type { AnnotationCharacterConfig } from '@lovelace_lol/embody/three';

export const HUMAN_ANNOTATION_OVERRIDES: Pick<AnnotationCharacterConfig, 'annotationRegions'> = {
  annotationRegions: [
    { name: 'left_eye', paddingFactor: 0.5, cameraAngle: 45 },
    { name: 'right_eye', paddingFactor: 0.5, cameraAngle: 315 },
  ],
};
```

`extendPresetWithProfile()` merges `annotationRegions` by region name, so a profile can override just the fields it needs without copying the full preset region array.

## Region Fields

Each annotation region supports these fields:

```ts
interface AnnotationRegion {
  name: string;
  bones?: string[];
  meshes?: string[];
  objects?: string[];
  paddingFactor?: number;
  cameraAngle?: number;
  cameraOffset?: { x?: number; y?: number; z?: number };
  parent?: string;
  children?: string[];
  expandAnimation?: 'outward' | 'staggered';
  style?: {
    markerColor?: number;
    markerRadius?: number;
    lineColor?: number;
    labelColor?: string;
    labelBackground?: string;
    labelFontSize?: number;
    opacity?: number;
    lineDirection?:
      | 'radial'
      | 'camera'
      | 'up'
      | 'down'
      | 'left'
      | 'right'
      | 'forward'
      | 'backward'
      | { x: number; y: number; z: number };
    line?: {
      style?: 'solid' | 'dashed' | 'dotted';
      curve?: 'straight' | 'bezier' | 'arc';
      arrowHead?: boolean;
      thickness?: number;
      length?: number;
    };
  };
  groupId?: string;
  isFallback?: boolean;
}
```

## Camera Fields

These are the fields that affect camera framing directly in the current runtime:

### `paddingFactor`

Camera distance multiplier for the region.

- Smaller values zoom in more.
- Larger values zoom out more.
- Runtime safety clamps may still stop the camera from moving closer for very small targets.

### `cameraAngle`

Horizontal orbit angle around the target, in degrees.

- `0` = front
- `180` = back
- `90` / `270` = side angles
- `45` / `315` = quarter-angle front-side views

Important runtime detail:

- If `cameraAngle` is omitted, the runtime may auto-angle small off-center targets such as eyes.
- If `cameraAngle: 0` is set explicitly, that forces a front view and disables the implicit auto-angle behavior.

Important laterality detail:

- `90` and `270` are treated as semantic side angles and can be remapped by the runtime for mirrored rigs.
- Other values such as `45` and `315` are treated as literal angles and are not automatically mirrored.

### `cameraOffset`

Final additive offset applied after the camera position is computed.

- Use this for small nudges.
- Do not use it as a replacement for semantic left/right camera behavior.
- In the current runtime it is applied in world space, not in model-local space.

## Marker Fields

These fields affect marker presentation, not camera framing:

### `style.lineDirection`

Controls the annotation line direction for marker placement.

- This changes where the marker line projects.
- It does not set the camera orbit angle.

### `style.line`

Controls line style, curve, arrow head, thickness, and length for marker rendering.

### Independent transient callouts

`showRuntimeAUAnnotations(auId, profile, options, morphTargetsByMesh)` previews
an AU's mapped target. `showRuntimeBoneAnnotation(boneName, options)` previews
one bone, and `showRuntimeMorphAnnotation(meshName, morphName, options)` previews
one concrete morph target without an AU binding. The standalone morph method
requires a loaded mesh and an existing morph dictionary name. Bone previews
resolve through the configured bone aliases/affixes. An unavailable target
fails without changing the preceding preview. Generated bone callouts, including
AU bone targets, anchor at the posed bone by default instead of raycasting onto
hair or skin. Pass `projectToSurface: true` to opt into surface projection.

All three methods use an independent transient visibility channel. They show
without turning on the saved annotations or changing `getMarkersVisible()` and
the Markers checkbox. Saved regions hide immediately during a preview, including
mid-fade. Their visibility preference, selection, solo and expansion remain
intact; solo and collapsed groups do not suppress a transient callout. Requests
replace previous transient targets by default. Set `replaceExisting: false` to
retain multiple requested targets; `maxTargets: 1` selects one mapped AU target.
`clearRuntimeAnnotations()` removes only transient targets, revealing saved
regions only when their current visibility preference is enabled. A visibility
edit during a preview changes that saved preference without hiding the preview.
Replacing/clearing the model or annotation configuration removes all transient
requests. An unmapped AU or unavailable standalone bone/morph leaves the preview
unchanged.

Generated bone and morph callouts use radial leaders even when general marker
defaults specify another direction. Rust recomputes their direction from the
posed anchor and current camera view on each update. It compares the anchor and
character center after perspective projection, so orbiting and panning retain
the outward side. Horizontally centered targets use the mapped side when it has
a visible projection, otherwise screen-right. Explicit directions on authored
regions keep their meaning. Label fitting still respects viewport bounds and
minimum leader length, so a callout can hide when insufficient room remains.

Transient marker spheres, leader lines, labels and arrowheads render above the
native character and hair with depth testing/writing disabled; ordinary saved
annotations retain their depth behavior. Transient HTML callouts also bypass
model occlusion. This is an authoring overlay; it does not change the model's
materials, render order or visibility.

```ts
controller.showRuntimeMorphAnnotation('Face', 'CustomSmile', { label: 'Smile' });
controller.showRuntimeBoneAnnotation('Jaw', { label: 'Jaw rotation' });
// The bone request replaces the preceding morph callout; saved markers stay hidden.
controller.clearRuntimeAnnotations();
```

## Geometry Target Fields

### `bones`

Names the bones used to define the annotation target.

Use this for stable semantic targets such as:

- `CC_Base_L_Eye`
- `CC_Base_R_Eye`
- `CC_Base_Head`
- `CC_Base_JawRoot`

### `meshes`

Names meshes used to define the region target.

Use this when the visible annotation surface is better described by mesh geometry than by a bone.

### `objects`

General object targets. `['*']` means the whole model.

## Recommended Authoring Pattern

For common behavior shared by a preset:

1. Put the default region behavior in the Embody preset under `annotationRegions`.
2. Override only the fields that truly differ for a specific character.

For runtime compatibility:

1. Prefer `annotationRegions` for stored profile overrides and preset extensions.
2. Treat top-level `config.regions` as the runtime mirror or a legacy fallback input, not the canonical authoring surface.

## Example: Eye Closeup

```ts
{
  name: 'left_eye',
  bones: ['CC_Base_L_Eye'],
  parent: 'head',
  paddingFactor: 0.5,
  cameraAngle: 45,
}
```

This means:

- target the left eye bone
- treat it as a child of `head`
- zoom in tightly
- approach from a front-side quarter angle
