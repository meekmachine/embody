// This fixture is copied into an isolated consumer of the packed package.
// The error assertions below fail if the public loader regresses to `any`.
import { initEmbodyCore as initFromRoot, getAUDescriptors as rootAUDescriptors, type AUDescriptor as RootAUDescriptor } from '@lovelace_lol/embody';
import {
  getAUDescriptors as wasmAUDescriptors,
  type AUDescriptor as WasmAUDescriptor,
  getEmbodyCore,
  initEmbodyCore,
  requireInitializedEmbodyCore,
  type EmbodyCore,
  type RuntimeCore,
  type NativePlaybackSession,
} from '@lovelace_lol/embody/wasm';
import { Object3D, type WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import {
  getAUDescriptors as threeAUDescriptors,
  type AUDescriptor as ThreeAUDescriptor,
  bindModelReferencePose,
  captureModelReferencePose,
  extendModelReferencePose,
  createDefaultCharacterScene,
  createDefaultCharacterSceneAsync,
  type DefaultCharacterScene,
  type DefaultCharacterSceneAsyncOptions,
  type ReadyDefaultCharacterScene,
  type CharacterSceneBackend,
  type CharacterSceneRenderer,
  type CharacterSceneRendererPreference,
  type ThreeModelReferencePose,
  DPthree,
  DPthreeCameraController,
  Embody,
  ThreeNativePlaybackConnector,
  resolveAnnotationCharacterConfig,
  createRuntimeAnnotationPreviewLifecycle,
  type AnnotationCharacterConfig,
  type MarkerStateSnapshot,
  type DPthreeCameraControllerConfig,
} from '@lovelace_lol/embody/three';

const annotationProfile: AnnotationCharacterConfig = { characterId: 'consumer', auPresetType: 'cc4' };
const resolvedAnnotationProfile = await resolveAnnotationCharacterConfig(annotationProfile);
declare const cameraOptions: DPthreeCameraControllerConfig;
const controller = new DPthreeCameraController(cameraOptions);
declare const renderModel: import('three').Object3D;
const modelReady: Promise<void> = controller.prepareModelForRender(renderModel, { signal: new AbortController().signal });
void modelReady;
// @ts-expect-error Readiness requires a Three model, not a serialized profile.
controller.prepareModelForRender({ characterId: 'consumer' });
// @ts-expect-error Cancellation uses an AbortSignal.
controller.prepareModelForRender(renderModel, { signal: true });
await controller.loadRegions(resolvedAnnotationProfile);
controller.subscribeMarkerState((state: MarkerStateSnapshot) => { const visible: boolean = state.visible; });
const preview = createRuntimeAnnotationPreviewLifecycle({ getAutoClearMs: () => undefined });
preview.start(); preview.dispose();
// @ts-expect-error Annotation constructors retain required Three scene inputs.
new DPthree({});
// @ts-expect-error Camera methods retain public region-name types.
controller.focusRegion(123);

const core: EmbodyCore = await initEmbodyCore();
const character = new Embody({ profileMode: 'profile', profile: {} });
const rootAUs: RootAUDescriptor[] = rootAUDescriptors({});
const wasmAUs: WasmAUDescriptor[] = wasmAUDescriptors({}, { bones: [] });
const threeAUs: ThreeAUDescriptor[] = threeAUDescriptors({});
const characterAUs: RootAUDescriptor[] = character.getAUDescriptors();
const sideSelection: boolean = rootAUs[0].bilateral;
const actualSides: Array<'left' | 'right' | 'center'> = rootAUs[0].availableSides;
void [wasmAUs, threeAUs, characterAUs, sideSelection, actualSides];
// @ts-expect-error Available sides must keep their explicit side vocabulary.
const invalidSide: 'both' = rootAUs[0].availableSides[0];
// @ts-expect-error Named semantic pose APIs have been retired.
character.getSemanticPoseCatalog();

character.onReady({ model: new Object3D() });
character.start();
character.stop();
// @ts-expect-error Public character controls cannot drive an animation clock.
character.update(0.016);
character.dispose();
declare const connector: ThreeNativePlaybackConnector;
connector.control('opaque', { type: 'setWeight', weight: 0.5 });
// @ts-expect-error Native weight is a number, not semantic intensity metadata.
connector.control('opaque', { type: 'setWeight', weight: 'strong' });
const runtime: RuntimeCore = new core.RuntimeCore(15);
runtime.configure_with_preset('cc4', '{}', '{}');
runtime.set_au(12, 0.5, 0);
runtime.load_au_morph_bindings(new Float32Array([12, 2, 0, 0, 1]));
runtime.set_mixed_aus(new Uint32Array([12]));
const value: number = runtime.get_au(12);
const balance: number = runtime.get_au_balance(12);
const viseme: number = runtime.get_viseme(0);
const jawScale: number = runtime.get_viseme_jaw_scale(0);
const frame: Float32Array = runtime.evaluate_active_morph_frame();
const clip: string = runtime.build_clip('smile', '{}', '{}');
const live: string = runtime.build_live_clip('live', 0.2);
const release: string = runtime.build_live_release_clip('release', live, 0.2);
const removed: boolean = runtime.remove_animation_clip('smile');
runtime.free();

// Lifecycle signatures come only from generated wasm-bindgen declarations.
const playback: NativePlaybackSession = new core.NativePlaybackSession();
const bindingBatch: string = playback.rebind('model', 'profile');
const playBatch: string = playback.play(clip, '{}');
const controlBatch: string = playback.control('opaque-handle', '{"type":"pause"}');
const editBatch: string = playback.replace_clip('opaque-handle', clip);
const eventBatch: string = playback.notify('{"type":"completed","handle":"opaque-handle"}');
const disposalBatch: string = playback.dispose();
playback.free();
// @ts-expect-error Playback takes serialized ClipIR, not a renderer object.
playback.play({}, '{}');
// @ts-expect-error Native controls require both handle and serialized request.
playback.control('opaque-handle');
// @ts-expect-error Handle identity is an opaque string.
playback.control(1, '{"type":"stop"}');
// @ts-expect-error Native callbacks are serialized events, not a frame delta.
playback.notify(0.016);
// @ts-expect-error This protocol has no frame update or elapsed-time API.
playback.update(0.016);
// @ts-expect-error The semantic compiler no longer has a compatibility clock.
runtime.update(0.016);
// @ts-expect-error Returned command batches retain their generated string type.
const wrongPlaybackBatch: number = playback.dispose();

const result: Float32Array = core.solve_bilateral_values(1, 0);
const presets: string[] = core.list_presets();
const profile: string = core.resolve_profile_view('{}');
const solver = new core.HairPhysicsSolver(core.default_hair_physics_config_values());
const hairFrame: Float32Array = solver.update(0.016, new Float32Array(5));
solver.free();

// Inferred types matter as well as explicitly annotated consumers.
const inferred = await initEmbodyCore();
const inferredRuntime = new inferred.RuntimeCore(0);
// @ts-expect-error Unknown Wasm module exports must be rejected.
inferred.missing_export();
// @ts-expect-error Runtime methods must come from wasm-bindgen declarations.
inferredRuntime.missing_method();
// @ts-expect-error AU ids are numeric.
inferredRuntime.set_au('12', 0.5, 0);
// @ts-expect-error Balance lookup requires a numeric AU id.
inferredRuntime.get_au_balance('12');
// @ts-expect-error Stored AU balances retain their generated numeric type.
const wrongBalance: string = inferredRuntime.get_au_balance(12);
// @ts-expect-error Direct viseme slots are numeric.
inferredRuntime.get_viseme('0');
// @ts-expect-error Direct jaw scales retain their generated numeric type.
const wrongJawScale: string = inferredRuntime.get_viseme_jaw_scale(0);
// @ts-expect-error All required arguments remain required.
inferredRuntime.set_au(12, 0.5);
// @ts-expect-error Packed Rust f32 slices require Float32Array.
inferredRuntime.load_au_morph_bindings([12, 2, 0, 0, 1]);
// @ts-expect-error Return values must retain their generated types.
const wrongFrame: string = inferredRuntime.evaluate_morph_frame_delta();
// @ts-expect-error Constructors retain numeric argument types.
new inferred.RuntimeCore('15');
// @ts-expect-error Helpers retain their argument types.
inferred.solve_bilateral_values('1', 0);
// @ts-expect-error Helpers retain their return types.
const wrongResult: number = inferred.solve_bilateral_values(1, 0);

// Every public route to the module must preserve the generated shape.
const rootCore = await initFromRoot();
const aliasCore = await getEmbodyCore();
const initializedCore = requireInitializedEmbodyCore();
// @ts-expect-error The root entrypoint must not widen the loader return type.
rootCore.missing_export();
// @ts-expect-error The async alias must not widen the loader return type.
aliasCore.missing_export();
// @ts-expect-error The synchronous accessor must not widen the loader return type.
initializedCore.missing_export();

// The packed Three entrypoint retains the immutable reference contract too.
const model = new Object3D();
const reference: ThreeModelReferencePose = captureModelReferencePose(model);
const extendedReference: ThreeModelReferencePose = extendModelReferencePose(model, reference);
const referenceNode = bindModelReferencePose(model, extendedReference).get(model);
if (referenceNode?.morphInfluences) {
  const influences: readonly number[] = referenceNode.morphInfluences;
  // @ts-expect-error Captured morph baselines are immutable.
  referenceNode.morphInfluences[0] = 1;
}
if (referenceNode?.rotationEuler) {
  // @ts-expect-error Authored Euler reference values are immutable.
  referenceNode.rotationEuler.x = 0;
}
// @ts-expect-error Extension requires an explicit prior reference snapshot.
extendModelReferencePose(model);

// Scene readiness is additive and cannot accidentally widen to an `any` renderer.
declare const container: HTMLElement;
const sceneOptions: DefaultCharacterSceneAsyncOptions = {
  type: 'studio', renderer: 'webgpu', signal: new AbortController().signal, lighting: { envMapEnabled: true },
  onDeviceLost: (error: Error) => { console.error(error.message); },
};
const pendingScene: Promise<ReadyDefaultCharacterScene> = createDefaultCharacterSceneAsync(container, sceneOptions);
const preference: CharacterSceneRendererPreference = 'auto';
const automaticScene: Promise<ReadyDefaultCharacterScene> = createDefaultCharacterSceneAsync(container, { renderer: preference });
const defaultScene: Promise<ReadyDefaultCharacterScene> = createDefaultCharacterSceneAsync(container);
const readyScene = await pendingScene;
const backend: CharacterSceneBackend = readyScene.backend;
// @ts-expect-error Auto is a preference, never a resolved backend.
const unresolvedBackend: CharacterSceneBackend = 'auto';
const renderer: CharacterSceneRenderer = readyScene.renderer;
if (readyScene.backend === 'webgpu') {
  const nativeRenderer: WebGPURenderer = readyScene.renderer;
  // @ts-expect-error Native WebGPU is not a WebGL renderer.
  const incorrectRenderer: WebGLRenderer = readyScene.renderer;
} else {
  const glRenderer: WebGLRenderer = readyScene.renderer;
}
new DPthreeCameraController({
  ...cameraOptions, renderer,
  renderFrame: async (activeRenderer, scene, camera) => { activeRenderer.render(scene, camera); },
  resizeRenderer: (activeRenderer, width, height) => { activeRenderer.setSize(width, height); },
  onRenderError: (error: Error) => { console.error(error.message); },
});
readyScene.resize();
readyScene.dispose();
const synchronousScene: DefaultCharacterScene = createDefaultCharacterScene(container);
synchronousScene.dispose();
// @ts-expect-error Scene construction requires an HTMLElement.
createDefaultCharacterSceneAsync('container');
// @ts-expect-error Cancellation requires an AbortSignal, not a flag.
createDefaultCharacterSceneAsync(container, { signal: true });
// @ts-expect-error The backend choice must be a supported renderer.
createDefaultCharacterSceneAsync(container, { renderer: 'vulkan' });
// @ts-expect-error Native WebGPU creation requires the asynchronous factory.
createDefaultCharacterScene(container, { renderer: 'webgpu' });
// @ts-expect-error Automatic renderer selection also requires the asynchronous factory.
createDefaultCharacterScene(container, { renderer: 'auto' });
// @ts-expect-error Lighting values retain their actual type.
createDefaultCharacterSceneAsync(container, { lighting: { exposure: 'bright' } });
// @ts-expect-error The caller must await readiness before using the renderer.
pendingScene.renderer.render(readyScene.scene, readyScene.camera);
// @ts-expect-error The renderer remains concrete, not an any-typed capability bag.
readyScene.renderer.nonexistentMethod();

// Character options must remain typed through the packed root and Three exports.
import type { CharacterPlaybackOptions as RootPlaybackOptions } from '@lovelace_lol/embody';
import type { CharacterPlaybackOptions, CharacterClipCompileOptions } from '@lovelace_lol/embody/three';
declare const character: Embody;
const clipOptions: CharacterClipCompileOptions = {
  balance: 0.2, balanceMap: { '12': -1 }, mixWeights: { 12: 0.5 },
  meshNames: ['Face'], snippetCategory: 'visemeSnippet', source: 'speech',
  autoVisemeJaw: false, jawScale: 0.7,
};
const playbackOptions: CharacterPlaybackOptions = {
  ...clipOptions, intensityScale: 0.8, intensity: 0.8, weight: 0.8, mixerWeight: 0.5,
  speed: 1, playbackRate: 1, rate: 1, timeScale: 1, reverse: false,
  time: 0.2, offsetSec: 0.2, loopMode: 'pingpong', loop: true, repeatCount: null,
  blendMode: 'replace', finalPose: 'hold', clampWhenFinished: true, easing: 'easeInOutCubic',
  additiveReferenceTimeSec: 0, fadeInSec: 0.1, fadeOutSec: 0.1, crossfadeDuration: 0.2,
  semanticAnimation: false,
};
const rootPlaybackOptions: RootPlaybackOptions = playbackOptions;
const characterPlayback = character.playAnimation('smile', rootPlaybackOptions);
characterPlayback.updateParams({ loopMode: 'pingPong', blendMode: 'normal', speed: 0.5 });
characterPlayback.setParams({ intensityScale: 1, blendMode: 'additive', finalPose: 'release' });
character.updateClipParams('smile', { easing: 'linear', repeatCount: 2 });
character.setAnimationLoopMode('smile', 'once');
character.setAnimationBlendMode('smile', 'replace');
character.setAnimationEasing('smile', 'easeIn');
character.playSnippet('smile', { '12': [{ time: 0, intensity: 1 }] }, playbackOptions);
character.playSnippet({ name: 'smile', curves: {} }, playbackOptions);
character.buildTypedClip('smile', [], clipOptions);
// @ts-expect-error Unknown options must not silently pass through the character API.
character.playAnimation('smile', { speeed: 2 });
// @ts-expect-error Numeric playback fields do not accept text.
characterPlayback.setParams({ speed: 'fast' });
// @ts-expect-error The object snippet overload must check its options too.
character.playSnippet({ name: 'smile', curves: {} }, { fadeInSeconds: 1 });
// @ts-expect-error Loop modes are a closed set, including the two ping-pong aliases.
character.setAnimationLoopMode('smile', 'forever');
// @ts-expect-error Blend modes are normal/replace or additive.
character.setAnimationBlendMode('smile', 'multiply');
// @ts-expect-error Easing must be one of the supported native materialization curves.
character.setAnimationEasing('smile', 'bounce');
// @ts-expect-error Final-pose values match the native connector contract.
character.updateClipParams('smile', { finalPose: 'freeze' });
// @ts-expect-error Compilation controls retain boolean types.
character.buildClip('smile', {}, { autoVisemeJaw: 'false' });
// @ts-expect-error Per-AU compilation strengths must be numeric.
character.buildTypedClip('smile', [], { mixWeights: { 12: 'strong' } });
// @ts-expect-error Legacy semantic animations must be decoded at the storage boundary.
character.buildClip('legacy', {}, { semanticAnimation: true });
