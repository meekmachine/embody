# Secondary Host Adapter Targets

Embody should keep Three.js as the first supported host while making the core
contracts realistic for Babylon.js, React Three Fiber, and Unity.

## Current Boundary

The shared package now has three layers:

- `@lovelace_lol/embody/core`: host-neutral descriptors, frame deltas, ClipIR,
  `TsRuntimeCore`, and `TsClipCompiler`.
- `@lovelace_lol/embody/three`: Three-specific inspection, frame application,
  ClipIR conversion, and mixer lifecycle.
- `@lovelace_lol/embody`: compatibility root that keeps existing Embody imports.

The adapter contract is intentionally numeric:

- models are described as `ModelDescriptor`
- runtime output is `FrameDelta`
- authored animation output is `ClipIR`
- host adapters own object lookup and mutation

This keeps Rust/Wasm, Babylon, R3F, and Unity from needing Three.js objects.

## Babylon.js

Babylon should be the first non-Three runtime target after the Three adapter is
stable because its browser/npm shape is closest to the current host.

Expected adapter pieces:

- `BabylonModelInspector`: convert Babylon meshes, skeleton bones, morph target
  managers, and animation groups into `ModelDescriptor`.
- `BabylonFrameApplier`: apply `FrameDelta` to morph target influences, bone
  transforms, and mesh visibility/material properties.
- `BabylonClipAdapter`: convert `ClipIR` into Babylon animations and animation
  groups.

Research anchors:

- Morph targets: https://doc.babylonjs.com/features/featuresDeepDive/mesh/morphTargets
- Animations: https://doc.babylonjs.com/features/featuresDeepDive/animation/animations

Primary risk:

- Babylon morph targets are managed through morph target managers rather than
  Three-style `Mesh.morphTargetInfluences` arrays, so descriptor ids must map to
  manager/target pairs instead of raw mesh slots.

## React Three Fiber

R3F should not need a separate core runtime. It should be a React integration
for the existing Three adapter.

Expected adapter pieces:

- React hooks for creating/disposal of `Embody`, `ThreeModelInspector`,
  `ThreeFrameApplier`, and `ThreeAnimationSystem`.
- Lifecycle helpers that bind loaded GLTF scenes to `onReady`.
- Optional suspense-friendly model descriptor extraction.

Research anchor:

- R3F renderer model: https://r3f.docs.pmnd.rs/getting-started/introduction

Primary risk:

- React lifecycle and disposal must not fight Three mixer ownership. The runtime
  should remain in the Three adapter; R3F should only orchestrate it.

## Unity

Unity should be treated as a bridge target, not a direct npm runtime target.
The cleanest path is exporting `ModelDescriptor`, `FrameDelta`, and `ClipIR`
data to Unity-side C# scripts or browser WebGL interop.

Expected adapter pieces:

- A Unity descriptor/import format for blendshapes and bones.
- A C# frame applier for blendshape weights, transforms, and visibility.
- A ClipIR-to-Unity AnimationClip converter or offline baking tool.

Research anchors:

- WebGL browser scripting interop: https://docs.unity3d.com/Manual/webgl-interactingwithbrowserscripting.html
- Animation clips: https://docs.unity3d.com/Manual/AnimationClips.html

Primary risk:

- Unity's runtime API and WebGL JS interop have different deployment constraints
  than npm/browser engines. Treat Unity as a generated/bridge target until the
  TypeScript and Rust core contracts are stable.

## Recommended Order

1. Finish routing Three live runtime through `TsRuntimeCore` and
   `ThreeFrameApplier`.
2. Route Three dynamic clips through `TsClipCompiler` and `ThreeClipAdapter`.
3. Add a small R3F wrapper because it reuses the Three adapter.
4. Prototype Babylon descriptor + frame application.
5. Only start Unity once `FrameDelta` and `ClipIR` are stable enough for a
   bridge format.
