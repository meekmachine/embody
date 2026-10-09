# Developing clear Embody code and consumer documentation

Use the [README architecture and public contracts](../README.md) to establish
current ownership. [VISION_AND_PRD](../VISION_AND_PRD.md) describes product intent;
it is not proof that an API or renderer integration exists. These rules guide
new and touched code, not an unsolicited rewrite of existing modules.

## Agent handoff

Follow the root [delivery workflow](../AGENTS.md#default-engineering-delivery-workflow):
inspect source, implement, commit and push, then provide the PR stack links as
**ready to test**. Do not execute tests, builds, typechecks, lint, verification
scripts, or manual/automated browser checks (including Playwright, Cypress,
screenshots for visual QA and browser performance tools). Do not monitor or wait
for CI or package publication. Pass the same restrictions to delegated agents;
only an explicit user request for the particular check changes this default.


## Make the runtime boundary visible

Trace the affected input through validation, profile/runtime computation, the
renderer-neutral result, adapter application and host observation. Functions
should name those domain operations rather than hide them in a generic handler.
Keep the Rust implementation authoritative for semantic controls, profile
semantics and computation. Adapters operate on renderer objects; the host mixer
owns clip playback and blending. Do not create a parallel TypeScript semantic
runtime or a second copy of live AU/viseme state.

For an AU animation bug, trace the caller's AU curve through profile compilation
to its bone and morph outputs before changing the caller. A mapped AU must drive
all of its available outputs in both live controls and compiled clips. Fix a
missing output in the owning Rust compiler/evaluator and add a regression there.
Do not make Polymer or LoomLarge read bone mappings, substitute a hardcoded jaw
rotation, or drop mapped morphs to make speech appear to work. Preserve the
existing LipSync timing and Animation scheduling flow; its AU/viseme curves are
the inputs to Embody, not a reason to duplicate Embody's mapping logic.

The boundary has real feature-specific responsibilities: annotation camera and
marker math live in Rust, while Three owns native inspection, labels, DOM controls,
marker state and disposal. Follow the README's annotation contract rather than
interpreting “thin adapter” as a prohibition on necessary browser lifecycle code.

- Distinguish semantic control IDs, AU IDs, viseme slots, bone names, mesh/target
  IDs and renderer handles. An identical integer or name does not make two
  namespaces equivalent. Use profile vocabulary consistently in code and docs.
- Expose units, coordinate frames, handedness and ownership in types/names or the
  immediate contract. Distinguish seconds from milliseconds, degrees from radians,
  normalized intensity from rotation, and character-left from viewer-left. For
  example, semantic animation `durationSeconds` and keyframe `time` are seconds;
  bilateral balance is a character-relative value, not an angle.
- Validate untrusted JSON and profile inputs at their entry boundary. Use typed
  internal representations and explicit variants where useful; make unsupported,
  missing and invalid values distinguishable. Avoid partial state updates after
  validation fails. Preserve deliberate compatibility defaults and document them.
  [Semantic pose code](../src/semantic_pose.rs) is a concrete input/validation
  boundary to inspect when changing that contract.
- Keep pure geometry, normalization and validation separate from engine writes,
  network/model loading and DOM work. Keep ownership of allocated resources and
  their release visible. On replacement/disposal, reject obsolete asynchronous
  work before it commits renderer objects; do not spread cleanup across callers.
- Name lifecycle transitions and legal call ordering. A reference pose, current
  evaluated pose, direct override and inherited clip start are distinct states
  or inputs, not interchangeable caches. Explain capture/restore timing where
  correctness depends on it.
- Keep errors tied to the failed operation and relevant control/target. Preserve
  causes at wrapping boundaries. Document intentional fallback and best-effort
  cleanup; do not silently report a failed runtime operation as success.
- Comments should preserve an invariant or explain an unexpected constraint.
  Prefer a concrete domain helper over an abstraction intended for hypothetical
  engines. Keep clarity refactors within the changed behavior and discuss broader
  boundary moves separately.

## Maintain the consumer contract in its existing home

Read the implementation and relevant tests before editing a capability claim.
Update the affected contract in the same PR and use real exported signatures and
payloads. Do not hand-edit generated Wasm declarations to make an example fit.

| Change | Documentation to inspect and update when affected |
| --- | --- |
| Public runtime/Wasm API, initialization, package use, ownership | [README](../README.md); [adapter boundary](ADAPTER_TARGETS.md) for adapter responsibilities |
| Annotation profile precedence, camera/marker configuration | [Annotation configuration](../ANNOTATION_CONFIGURATION.md) and README annotation lifecycle |
| Capture or reuse of reference poses, clip conversion | [Animation reference poses](ANIMATION_REFERENCE_POSES.md) |
| Inheritance of current values at clip creation | [Inherited clip starts](INHERITED_CLIP_STARTS.md) |
| Humanoid roles, semantic body control/profile authoring | [Body controls](body-controls.md) and README semantic pose/clip contracts |
| Benchmark or performance claim | [Runtime benchmarks](RUNTIME_BENCHMARKS.md), including measured workload and limits |

For numeric or binary contracts, state ranges, units, layout and invalid-input
behavior as relevant. Explain the precondition and observable result of examples:
capturing a reference before playback and reusing it afterward is different from
sampling the currently animated rig. Preserve that distinction rather than
claiming automatic bind-pose recovery or retargeting.

Describe the runtime benefit honestly: compiling a semantic clip is not an
implemented animation-authoring screen. Identify required Polymer/host work when
there is any. Keep intended designs labeled, and describe compatibility changes
and consumer migration where applicable. Do not repeat an entire architecture or
require a large template for a small correction; link the durable contract.
If existing documents conflict, verify the owning code and resolve the affected
claim instead of propagating an obsolete restriction.

## Verify the observable contract

Name tests by input condition and expected result. Check outputs or visible state
at the appropriate Rust, adapter or package boundary rather than private helper
structure. For changed numeric contracts, include relevant bounds and invalid
values; for ownership changes, verify that unrelated controls remain intact.
For changed loading/disposal paths, cover stale completion and released resources.
Choose cases based on the actual change, not a mandatory matrix for every edit.

Report whether evidence covers Rust computation, generated package exports,
renderer integration or a real host/device flow. A unit test of ClipIR does not
prove that a host renders or blends it correctly, and a performance claim needs
measured evidence. Follow AGENTS build/package checks when code changes; review
links and examples for documentation-only edits. Request restructuring in review
when a specific ambiguity or boundary violation risks wrong behavior, not because
of arbitrary function sizes or preferred prose.
