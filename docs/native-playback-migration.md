# Native playback repair for Polymer #299

LoomLarge's animation controls and Polymer's scheduled snippets need the same
Embody playback interface. A native animation host must execute the resulting
clips. [Polymer #299](https://github.com/meekmachine/Polymer/issues/299) defines
the required end state and exclusions. This plan has five stages. Mapping and
character lifecycle remain separate PRs within stage 3; stage 5 separates caller
cleanup from the final pins-only preview. The first PR adds a command contract,
not working application playback.

The user's clarification makes the command boundary explicit: Polymer and
LoomLarge must not call `engine.update`. Three.js supplies playback timing;
Embody's connector translates play, stop, speed, blend, intensity and other
controls into native actions within the existing Three rendering integration.

## Source audit

Inspected on October 16, 2026, without executing tests or application flows:

- Embody main `a55e89edbb22b26059a63ce002a2c3e25caf0cf0`.
- Polymer main `27ef0c4d8ec1eab203edbbd0fbf01b2a57f1af8a`.
- LoomLarge main `f84d9c66e0e70864ab38170aff86ee50ae21eb1e`.

| Observed source | Consequence for the repair |
| --- | --- |
| [Polymer handle lookup](https://github.com/meekmachine/Polymer/blob/27ef0c4d8ec1eab203edbbd0fbf01b2a57f1af8a/src/polymer/runtime/rust_embody_host.cljs#L1445) resolves the current action by clip name. | A retained handle can address a newer play of the same clip. Playback identity must include session and binding generation, independent of the clip name. |
| [Animation scheduler](https://github.com/meekmachine/Polymer/blob/27ef0c4d8ec1eab203edbbd0fbf01b2a57f1af8a/src/polymer/animation/scheduler.cljs#L94) estimates completion with a duration timer; pause does not remove that timer. | A request can settle while native playback is paused. Use native terminal events and retain existing scheduler admission/cancellation behavior. |
| [Animation service](https://github.com/meekmachine/Polymer/blob/27ef0c4d8ec1eab203edbbd0fbf01b2a57f1af8a/src/polymer/animation/service.cljs#L381) defines completion emitters without callers, and the scheduler discards baked playback handles. | Existing UI completion subscriptions need actual native events. Deleting duplicate state must preserve those event names and payloads. |
| [EyeHead](https://github.com/meekmachine/Polymer/blob/27ef0c4d8ec1eab203edbbd0fbf01b2a57f1af8a/src/polymer/eye_head/scheduler.cljs#L410) estimates progress then timer-seeks/pauses; [LipSync](https://github.com/meekmachine/Polymer/blob/27ef0c4d8ec1eab203edbbd0fbf01b2a57f1af8a/src/polymer/lipsync/scheduler.cljs#L77) finishes from estimated duration. | Folder deletion alone misses these playback implementations. Retain agency decisions and speech timing inputs while replacing playback completion/holding with native facts and commands. |
| [Gesture](https://github.com/meekmachine/Polymer/blob/27ef0c4d8ec1eab203edbbd0fbf01b2a57f1af8a/src/polymer/agencies/action/gesture/scheduler.cljs#L45) completes at `maxTime + 50ms`, and its agency then requests animation removal. | A paused or slowed gesture can be removed before native completion. Include Gesture in the same terminal-event migration. |
| [Embody runtime](../src/runtime.rs) returns a `host:<name>` marker from `play_animation`, while [animation.rs](../src/animation.rs) retains sampling, blending and time advancement code. | Neither the marker nor removal of the unused engine provides a native connector. Remove the old machinery when its catalog/consumer responsibilities have a real replacement. |
| [ThreeGazeFocus](../three/gaze.ts) restores and applies bone corrections around mixer evaluation. | Removing RAF alone leaves a second pose writer. Remove this playback path and route existing head/eye snippets through ordinary compiled clips. |
| [Face-selection draft #145](https://github.com/meekmachine/embody/pull/145) changes profile routing and adds live/compiled-output tests. | Preserve the approved behavior, then extend coverage to clearing contributions from an already running native clip. The draft's compile-time coverage alone does not establish that cleanup. |

The source audit did not establish a universal 35% multiplier in the Rust
compiler. Full-strength output and asymmetric bounds remain required regression
cases; do not change unrelated policy constants merely because they equal 0.35.

## Delivery stages and acceptance gates

Each implementation PR starts from its repository's current `main`. Same-repo
dependent slices wait for an authorized merge; they are not branches stacked on
open PRs. CI executes the authored coverage. No slice is complete merely because
its interfaces exist.

| Stage / PR | Owner and deliverable | CI evidence required | Dependency and status |
| --- | --- | --- | --- |
| 1. Rust command and lifecycle contract | Embody `NativePlaybackSession`: validated compiled clips, opaque handles, playback controls, replacement/overlap, native terminal events and release commands. | A non-Three fake connector exercises stale/foreign handles, duplicate/late completion, interruption, held poses, zero-duration clips, looping, invalid replacement, rebind and disposal. Built-package imports and generated declarations cover the API. | First implementation in this branch. No native connector or migrated consumer yet. |
| 2. Three connector and render connection | Embody maps the contract to native clips/actions. Three supplies timing inside the existing render integration; no external `engine.update` API. | Native action tests cover pause/resume, speed/weight/blending, finite/infinite loops, overlap/replacement, native completion, held pose release and resource counts. Render tests prove zero advancement while suspended and exactly one advancement per step, including renderer replacement. | Requires slice 1. Prove the character editor/preview, R3F and embed render connections below before deleting their old runtime. |
| 3a. Semantic and face mapping parity | Embody compiles semantic, live preview and hair inputs for that connector. Include reviewed #145 routing and remove active contributions from meshes excluded by a new selection. | AU103 and other custom mappings retain every bone and morph; full activation reaches configured bounds, including asymmetric rotations. Absent/empty/replaced face selection has explicit results; body/hair/bone output stays independent. Semantic strength and native weight each apply once. | Rust mapping work can be reviewed independently; active-clip cleanup requires stage 2. Do not claim #145 alone covers that case. |
| 3b. Embody character facade | Embody owns creation, initialization, model/profile binding, clip catalog/authoring and disposal. Provide the supported UI command contract over the connector. Remove obsolete Rust playback and legacy gaze implementation once callers use the replacement. | Initialization failure, model/profile replacement, disposal during load, repeated replacement without resource growth, real start/stop and consumer declaration tests. All imported clips, snippets, previews and hair use the shared contract. | Requires 2 and 3a. This is the replacement needed by Polymer, not a renamed copy of Polymer's animation runtime. |
| 4. Polymer forwarding and deletion | Delete all `src/polymer/runtime/`; update exports/declarations/contract checks and existing callers to minimal Embody forwarding. Replace timers/fades/seek loops outside that folder with commands and native facts. Keep agency planning/routing unchanged, subject to the terminal-delivery decision below. | Public consumer imports, scheduler request/terminal-event tests, stale callback isolation, actual lifecycle parity, and a source ownership check against reintroducing the runtime. | Requires 3b's compiled immutable package. Runtime deletion and caller updates land together. |
| 5a. LoomLarge caller cleanup | Remove `engine.update` calls and elapsed-time arithmetic from the landing character and embed render paths. Adopt the compiled connector dependency required by those removals. | Native-render fixtures replace tests that drive the old engine; UI controls still issue the same native playback requests without a host clock. | Requires stage 4's compiled immutable package. This is an explicit consumer source PR, separate from the final preview. |
| 5b. LoomLarge dependency-only preview | Change only `frontend/package.json`, `loomlarge_lol/package.json` and `pnpm-lock.yaml` after caller cleanup. | CI exercises built-package imports and supported UI commands against the exact Polymer package and transitive Embody package. Character editor/preview playback, speed, intensity, loops, pause/resume, stop and seek remain end-to-end acceptance criteria. | Requires 5a and the exact compiled packages selected for adoption. No host PR or package pin is fabricated for stage 1. |

## Render connection is a prerequisite

In LoomLarge, [CharacterGLBScene](https://github.com/meekmachine/LoomLarge/blob/f84d9c66e0e70864ab38170aff86ee50ae21eb1e/frontend/src/scenes/CharacterGLBScene.tsx#L850)
constructs `DPthreeCameraController`, then separately binds `{meshes, model}` to
the character engine and calls `start()`. Embody's
[existing render loop](../three/annotations/DPthreeCameraController.ts) calls
its camera update and native render; it currently has no playback-session hook.
[Scene rendering bindings](../three/sceneRenderingBinding.ts) coordinate renderer
replacement, not character animation.

The [R3F host](https://github.com/meekmachine/LoomLarge/blob/f84d9c66e0e70864ab38170aff86ee50ae21eb1e/frontend/src/components/LoomBustScene.tsx#L47)
and [embed host](https://github.com/meekmachine/LoomLarge/blob/f84d9c66e0e70864ab38170aff86ee50ae21eb1e/frontend/src/embed/runtime.ts#L383)
already call `engine.update(dt)` from their own frame callbacks.
Those calls must be removed, not preserved or turned into no-ops. Slice 2 must
establish an Embody-owned connection to the existing Three rendering paths and
prevent duplicate advancement. Model identity alone does not identify which
renderer owns a frame; an explicit binding to that rendering integration needs
review. Removing existing application callers needs
a separately reviewed consumer cleanup; the final preview remains pins-only.
Do not insert an application clock or fallback RAF to avoid this integration.

The cleanup removes the landing scene's `useFrame` animation callback/import and
the embed runtime's `previousTime`, `performance.now()` delta arithmetic and
`engine.update` call. Its render callback remains for rendering. Update existing
tests that call or mock `engine.update` to exercise the connector with native
render fixtures. Land this source cleanup only with the compiled dependency
that supplies the replacement connection, and keep it separate from the final
three-file adoption PR. `CharacterGLBScene` has no `engine.update` call; its
`start()` must attach/activate the connector without creating a Polymer clock.
An explicit attachment there may also need a narrow caller change. Do not assume
that the two `update` removals are the only integration edits before the native
render connection is designed. In particular, the annotation camera controller
is not a generic replacement for the embed renderer: it also initializes camera
controls and annotation behavior.

Use native [AnimationAction](https://threejs.org/docs/pages/AnimationAction.html)
controls for playback, weights and fades. Native
[AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html) advancement
still needs the existing render integration. A native
[Timer](https://threejs.org/docs/pages/Timer.html) may supply that render
integration's timing behind Embody's connector boundary; it must not introduce
a second clock. Reading native progress may inform a display; neither Polymer
nor the UI should extrapolate a playhead.

Before removing Gesture/LipSync completion timers, establish how native terminal
facts reach the requesting agency. Current character routing publishes Animation
events without a return route to these owners. If the existing stream contracts
cannot carry the result, resolve that specific conflict with #299's unchanged
routing requirement before implementation. Do not strand active requests, add
host-side routing, or silently expand this into an agency redesign.

## Consumer compatibility inventory

Stage 3b must establish these call families before stage 4 deletes their
implementation. Minimal forwarding may preserve names; it must not maintain a
second playback state or implementation.

| Existing consumer contract | Required replacement evidence |
| --- | --- |
| `initEmbodyCore`, `isEmbodyCoreReady`, `createRustEmbodyHost`, `createRustEmbodyHostUnbound`, `Embody.create` | Successful and failed initialization, including an unbound host, remain observable. |
| `onReady`, `bindModel`, `extendReferencePose`, `getProfile`, `setProfile`, `start`, `stop`, `clear`, `resetToNeutral`, `dispose` | Real binding/native-action/lifecycle operations; late work cannot touch a replaced model. Start/stop must not create or drive a custom clock. |
| Existing `engine.update(dt)` calls | Remove these calls and the exported driver API after connecting the existing Three render paths inside Embody. No no-op compatibility replacement. |
| AU/continuum/viseme/morph authoring, semantic poses/animations, body controls, hair/material controls | Preserve getters and mapping semantics; timed previews use compiled clips and native controls. |
| `loadAnimationClips`, `registerAnimationClips`, `removeAnimationClip`, `getAnimationClips`, playback and parameter methods | Imported clips share the snippet command contract and native lifecycle. |
| Snippet `loadFromJSON`, `schedule`, `updateSnippet`, `remove`, `play`, `pause`, `stop`, `restartSnippet`, `setSnippetPlaying`, `setSnippetTime` and parameter setters | Compile/update requests preserve rate, strength, balance, blend/easing, loop/repeat and reverse semantics without a parallel playhead. |
| Instance `events`, `eventEmitter` snippet queries, baked snapshots, completion event names | Native completion reaches existing [Emote authoring](https://github.com/meekmachine/LoomLarge/blob/f84d9c66e0e70864ab38170aff86ee50ae21eb1e/frontend/src/components/au/EmoteAuthoringPanel.tsx#L573) and discrete [animation stream](https://github.com/meekmachine/LoomLarge/blob/f84d9c66e0e70864ab38170aff86ee50ae21eb1e/frontend/src/hooks/useAnimationStream.ts#L40) consumers. |
| `createEmbodyGazeRuntime` | Preserve existing geometry/agency inputs while removing `ThreeGazeFocus` and its pose overrides; no replacement gaze motor. |

## Existing drafts, exclusions and handoff

[LoomLarge #1142](https://github.com/meekmachine/LoomLarge/pull/1142),
[Polymer #298](https://github.com/meekmachine/Polymer/pull/298) and
[Embody #148](https://github.com/meekmachine/embody/pull/148) remain existing
drafts, not accepted replacements. Review individual compilation/cleanup fixes
before carrying them forward. Include the approved face-selection behavior from
[#145](https://github.com/meekmachine/embody/pull/145) in stage 3a. Closing or merging
any of these PRs is a separate, explicitly authorized action.

Camera-relative features, Bones-tab UI, annotation migration and broader agency
redesign stay deferred. The annotation controller's camera/marker timing and
fallback timers are separately owned and remain outside this playback repair;
do not claim that every subsystem timer has been removed.

Handoff each draft as **ready to test** with source-inspection limits. Preserve
CI/release gates, use only published immutable compiled previews downstream,
and link the replacement stack reciprocally when it exists. Do not build
locally or wait/poll for CI or artifacts. Missing packages are pending
dependencies, not reasons to use a source archive or invent a package URL.
