# Embody writing examples from the repository

Use these examples with [development guidance](development-guidance.md). Original
excerpts are exact and linked to the revision reviewed. “Weak” describes reuse in
the wrong artifact or without necessary context, not a defect in product vision.
Proposed wording is an evidence-backed writing example, not newly shipped behavior
or a report that tests ran. Recheck current contracts before reusing it.

## 1. Turn product intent into a concrete consumer contract

**Original excerpt:**

> embody lets developers work in the language of performance instead of the language of rig plumbing.

Source: [Vision and PRD, What Makes embody Valuable](https://github.com/meekmachine/embody/blob/1bae470eb502833c33fdb886f6a5ed7ba2951684/VISION_AND_PRD.md#what-makes-embody-valuable)
(original emphasis omitted).

**Weak as a PR's entire result:** It explains the ambition, but not which operation
changed, what a consumer receives, or which layer plays the animation. Keep it in
vision writing; use a concrete contract when describing implementation.

**Proposed stronger technical summary:**

> On a `RuntimeCore` instance, `build_semantic_clip(name, animationJson, optionsJson)`
> compiles semantic control tracks into clip output for the host mixer. The animation
> payload names `controlId`, direction, keyframes and `durationSeconds`; the host
> animation library owns playback and blending. This API is a runtime building
> block, not an animation-authoring screen.

Evidence: [README semantic pose and animation API](https://github.com/meekmachine/embody/blob/1bae470eb502833c33fdb886f6a5ed7ba2951684/README.md#L378)
and [semantic animation validation/compilation](https://github.com/meekmachine/embody/blob/1bae470eb502833c33fdb886f6a5ed7ba2951684/src/semantic_pose.rs#L116).
A real PR must identify the specific changed contract; this summary does not claim
that the existing API was introduced by a new change.

**Rule:** Connect the benefit to an exported operation, payload/result, and consumer
responsibility. Name required host work without inventing an integrated UI.

## 2. Expand “foundation” into a call sequence and its limits

**Original excerpt:**

> This is the first foundation for reliable imported animation retargeting,

Source: [Animation reference-pose foundations, opening paragraph](https://github.com/meekmachine/embody/blob/1bae470eb502833c33fdb886f6a5ed7ba2951684/docs/ANIMATION_REFERENCE_POSES.md).
This is the first line of a sentence; the full paragraph already limits its scope.

**Weak as a standalone issue/PR summary:** It can sound like retargeting now works.
The useful implementation detail is explicit reference data, not a new rig pairing.

**Proposed stronger consumer summary:**

> Establish the desired reference pose before playback or live controls, then
> call `captureModelReferencePose(model)`. Create a `ThreeModelInspector` instance
> and pass that same snapshot to its `inspectModel(model, { profile, referencePose })`
> method when reinspecting after profile changes. Calling capture again samples the current
> pose; it does not recover a bind pose. These reference-pose APIs do not retarget
> clips or establish that independently authored rigs are compatible.

Evidence: [reference versus rendered pose](https://github.com/meekmachine/embody/blob/1bae470eb502833c33fdb886f6a5ed7ba2951684/docs/ANIMATION_REFERENCE_POSES.md#reference-pose-versus-the-current-rendered-pose),
[hierarchy and identity](https://github.com/meekmachine/embody/blob/1bae470eb502833c33fdb886f6a5ed7ba2951684/docs/ANIMATION_REFERENCE_POSES.md#hierarchy-and-identity),
and [capture implementation](https://github.com/meekmachine/embody/blob/1bae470eb502833c33fdb886f6a5ed7ba2951684/three/reference-pose.ts#L129).

**Rule:** For lifecycle-sensitive APIs, state the precondition, operation, reuse
sequence, and limitation. Keep aspirational next steps distinct from the delivered
primitive. Preserve the original page's explicit limitations when shortening it.

## 3. Preserve good units and coordinate conventions

**Existing good excerpt:**

> AU balance uses the character's left/right: `-1` drives the left side,
> `0` drives both, and `1` drives the right.

Source: [README, AU balance contract](https://github.com/meekmachine/embody/blob/1bae470eb502833c33fdb886f6a5ed7ba2951684/README.md#L142).

**Why it works:** It gives the coordinate convention and the meaning of all three
reference values. “Adjust the balance” alone would leave a host author guessing
whether left means character-left or viewer-left, and whether zero disables both.

**Proposed wording when carrying this contract into consumer documentation:**

> Interpret AU balance from the character's perspective: `-1` selects the left
> side, `0` drives both sides, and `1` selects the right. Do not interpret it as an
> angle or flip it merely because the viewer faces the character.

This preserves the documented convention; it does not change the setter's range
or claim that every control supports bilateral output. For semantic animation,
link the [direction/output validation contract](https://github.com/meekmachine/embody/blob/1bae470eb502833c33fdb886f6a5ed7ba2951684/README.md#L398) when relevant.

**Rule:** Put units, ranges, coordinate frames, and invalid-input behavior next to
the affected field. Reuse the project's exact vocabulary instead of an apparently
simpler phrase that discards a necessary distinction.
