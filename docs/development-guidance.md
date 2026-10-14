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
all of its configured outputs in both live controls and compiled clips. Check
the saved mapping and existing rotation groups before changing the compiler;
fix the owning profile or Rust code and add a regression for the missing output.
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

## Write claims at the boundary the change controls

A consumer uses a PR description to decide which behavior changes when adopting
the package. Lead with the input condition, failure, and resulting output. Put
scope and compatibility qualifications beside the claim they limit. For example,
"an empty face category produces no face-routed morph bindings" names a compiler
contract; "clearing face selection stops facial animation" also promises host UI,
other category, and playback behavior that needs separate evidence.

The source review of [Embody #145](https://github.com/meekmachine/embody/pull/145)
at `205aecf` and its consumer [LoomLarge #1120](https://github.com/meekmachine/LoomLarge/pull/1120)
at `7b5d51a` provides a concrete example. Treat these as revision-specific writing
examples and recheck current source before reusing their behavior claims:

- **State the category boundary.** The compiler fix restricts morph bindings to
  a configured category's resolved meshes. The
  [CC4 preset](https://github.com/meekmachine/embody/blob/205aecf9b78fe53eebc9eb333fddc9e3eca0db38/assets/presets/cc4.json#L2258-L2289)
  routes eyelids through `eye` and speech shapes through `viseme`. Clearing
  `face` therefore leaves those categories and independent bone mappings alone.
  This distinction tells a host author which setting must change for the desired
  output; a broad statement about all facial animation would misdirect them.
- **Include compatibility in the contract.** "Only selected meshes animate" is
  ambiguous when the
  [resolver expands legacy names](https://github.com/meekmachine/embody/blob/205aecf9b78fe53eebc9eb333fddc9e3eca0db38/src/profile.rs#L1587-L1601).
  Write "Exact names select one mesh; when no exact mesh exists, a legacy name
  can resolve to numbered primitive meshes." For example, `Skin` may resolve to
  `Skin_1` and `Skin_2`. A host checklist that compares literal names can show
  those concrete targets unchecked. Describe that integration gap explicitly;
  compiler enforcement alone does not establish correct checklist behavior.
- **Describe what the evidence reaches.** The
  [added runtime test](https://github.com/meekmachine/embody/blob/205aecf9b78fe53eebc9eb333fddc9e3eca0db38/src/runtime.rs#L3444-L3514)
  uses a synthetic AU routed through `face` and asserts live frame and compiled
  clip outputs. "Added regression coverage for category selection and independent
  bone bindings; tests were not run" describes the work. It does not establish
  rendered behavior, real CC4 checklist routing, or successful execution.

The reason to write this way is practical: a reviewer must be able to distinguish
the implemented library behavior from the consumer experience still to deliver.
Use the exported API or field name when it makes that distinction precise, and
define terms such as AU (facial action unit) and viseme (speech shape) when the
intended reader needs them. Replace vague descriptions of "strict routing" with
the specific fallback removed and the compatibility behavior retained.

Keep a small PR description short: the problem and resulting behavior, material
compatibility or host work, and actual verification. Link durable detail rather
than narrating every helper or historical commit. Explain downstream package
adoption separately from the source fix; a linked PR does not establish that a
consumer has installed or deployed it. Keep unresolved findings visible after
copy edits instead of changing their status to fixed.

Before handoff, check whether the title and opening could imply a broader output,
completed integration, or stronger evidence than the final diff supports. Narrow
that claim and name the remaining work. This editorial review does not authorize
local tests, browser validation, or waiting for CI.

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
