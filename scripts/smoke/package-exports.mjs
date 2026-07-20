import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = await import('@lovelace_lol/embody');
const core = await import('@lovelace_lol/embody/core');
const three = await import('@lovelace_lol/embody/three');
const cljs = await import('@lovelace_lol/embody/cljs');
const wasm = await import('@lovelace_lol/embody/wasm');

const rootCjs = require('@lovelace_lol/embody');
const coreCjs = require('@lovelace_lol/embody/core');
const threeCjs = require('@lovelace_lol/embody/three');
const cljsCjs = require('@lovelace_lol/embody/cljs');
const wasmCjs = require('@lovelace_lol/embody/wasm');

const wasmCore = await wasm.initEmbodyCore();
const wasmCoreFromCjs = await wasmCjs.initEmbodyCore();
const skeletonFitTransform = wasmCore.compose_template_skeleton_fit_transform(
  1.2,
  new Float32Array([0.1, 0.2, -0.1]),
  1.05,
  new Float32Array([0.01, -0.02, 0.03]),
);
const fitVertices = new Float32Array([
  -0.5, 0.0, -0.2,
  0.5, 0.0, 0.2,
  -0.45, 1.0, -0.18,
  0.45, 1.0, 0.18,
  -0.35, 1.8, -0.15,
  0.35, 1.8, 0.15,
]);
const meshProportions = wasmCore.analyze_mesh_proportions(fitVertices, 1);
const skeletonFitSolution = wasmCore.solve_template_skeleton_fit(
  fitVertices,
  new Float32Array([-10.0, 0.0, -5.0, 10.0, 100.0, 5.0]),
  1,
  0,
);
const rustHair = await root.createRustHairPhysics();
const annotationCamera = await root.createRustAnnotationCameraCore();
const focusFraming = annotationCamera.solveFocusFraming({
  focusBounds: { center: { x: 0, y: 0.9, z: 0 }, size: { x: 0.8, y: 1.8, z: 0.4 } },
  fovDegrees: 45,
  aspect: 1,
  minDistance: 0.5,
  closeUpPaddingFactor: 1.2,
  zoomPaddingFactor: 1.5,
  fullBodyPaddingFactor: 2.0,
});
const markerLineScale = annotationCamera.resolveViewportConstrainedLineScale({
  startClip: [0, 0, 0, 1],
  endClip: [2, 0, 0, 1],
  safeX: 0.8,
  safeY: 0.9,
});
const cameraFlight = annotationCamera.createCameraFlight(
  { x: 0, y: 1, z: 3 },
  { x: 0, y: 1, z: 0 },
  { x: 2, y: 1.4, z: 0 },
  { x: 0.1, y: 1.2, z: 0 },
  500,
);
const cameraFlightEnd = cameraFlight.sample(500);
cameraFlight.dispose();
const rustHairOutput = rustHair.update(0.016, {
  yaw: 0,
  pitch: 0,
  roll: 0,
  yawVelocity: 1,
  pitchVelocity: 0,
});
rustHair.dispose();

const checks = [
  ['root Embody ESM', typeof root.Embody === 'function'],
  ['root Embody CJS', typeof rootCjs.Embody === 'function'],
  ['root createCharacterHost ESM', typeof root.createCharacterHost === 'function'],
  ['root createCharacterHost CJS', typeof rootCjs.createCharacterHost === 'function'],
  ['root createDefaultCharacterScene ESM', typeof root.createDefaultCharacterScene === 'function'],
  ['root CHARACTER_SCENE_TYPES ESM', typeof root.CHARACTER_SCENE_TYPES === 'object' && root.CHARACTER_SCENE_TYPES !== null],
  ['root loadCharacterModel ESM', typeof root.loadCharacterModel === 'function'],
  ['root normalizeDefaultCharacterLightingSettings ESM', typeof root.normalizeDefaultCharacterLightingSettings === 'function'],
  ['three Embody ESM', typeof three.Embody === 'function'],
  ['three Embody CJS', typeof threeCjs.Embody === 'function'],
  ['three createCharacterHost ESM', typeof three.createCharacterHost === 'function'],
  ['three createDefaultCharacterScene ESM', typeof three.createDefaultCharacterScene === 'function'],
  ['three loadCharacterModel ESM', typeof three.loadCharacterModel === 'function'],
  ['three normalizeDefaultCharacterLightingSettings ESM', typeof three.normalizeDefaultCharacterLightingSettings === 'function'],
  ['three inspector ESM', typeof three.ThreeModelInspector === 'function'],
  ['three clip adapter ESM', typeof three.ThreeClipAdapter === 'function'],
  ['three applier CJS', typeof threeCjs.ThreeFrameApplier === 'function'],

  ['cljs runtime ESM', typeof cljs.createAnimationRuntime === 'function'],
  ['cljs runtime CJS', typeof cljsCjs.createAnimationRuntime === 'function'],
  ['wasm init ESM', typeof wasm.initEmbodyCore === 'function'],
  ['wasm init CJS', typeof wasmCjs.initEmbodyCore === 'function'],
  ['wasm core ABI ESM', wasmCore.core_abi_version() === wasm.EMBODY_CORE_ABI_VERSION],
  ['wasm core ABI CJS', wasmCoreFromCjs.core_abi_version() === wasmCjs.EMBODY_CORE_ABI_VERSION],
  ['wasm bilateral helper', Array.from(wasmCore.solve_bilateral_values(0.8, 0.25)).join(',') === '0.6000000238418579,0.800000011920929'],
  ['wasm skeleton fit helper', Math.abs(skeletonFitTransform[0] - 1.26) < 1e-6 && Math.abs(skeletonFitTransform[3] - -0.07) < 1e-6],
  ['wasm mesh proportions helper', meshProportions.length === wasm.MESH_PROPORTIONS_STRIDE && meshProportions[15] > 0.7],
  ['wasm skeleton fit solver', skeletonFitSolution.length === wasm.TEMPLATE_SKELETON_FIT_SOLUTION_STRIDE && Math.abs(skeletonFitSolution[0] - 0.018) < 1e-6 && skeletonFitSolution[9] === 1],
  ['root Rust hair factory', typeof root.createRustHairPhysics === 'function'],
  ['root Rust hair output', rustHairOutput.L_Hair_Left > 0 && rustHairOutput.R_Hair_Left > 0],
  ['root Rust annotation camera factory', typeof root.createRustAnnotationCameraCore === 'function'],
  ['wasm annotation focus framing', focusFraming.distance > 0 && Math.abs(focusFraming.target.y - 0.9) < 1e-5],
  ['wasm marker line clipping', markerLineScale.visible && Math.abs(markerLineScale.lineScale - 0.4) < 1e-5],
  ['wasm marker angle gate', annotationCamera.passesMarkerCameraAngleGate({ markerAngle: 350, currentCameraAngle: 10 })
    && !annotationCamera.shouldShowMarker({ hiddenChild: false, solo: 'other-soloed' })],
  ['wasm camera flight endpoint', cameraFlightEnd.done && Math.abs(cameraFlightEnd.position.x - 2) < 1e-5],
  ['core compiler ESM', typeof core.TsClipCompiler === 'function'],
  ['core runtime ESM', typeof core.TsRuntimeCore === 'function'],
  ['root compiler CJS', typeof rootCjs.TsClipCompiler === 'function'],
  ['root runtime CJS', typeof rootCjs.TsRuntimeCore === 'function'],
  ['root humanoid skeleton template ESM', root.JONATHAN_HUMANOID_SKELETON_TEMPLATE?.id === 'jonathan-cc-base'],
  ['root humanoid skeleton template CJS', rootCjs.JONATHAN_HUMANOID_SKELETON_TEMPLATE?.id === 'jonathan-cc-base'],
  ['root humanoid skeleton template lookup ESM', typeof root.getHumanoidSkeletonTemplate === 'function'],
  ['root humanoid skeleton template lookup CJS', typeof rootCjs.getHumanoidSkeletonTemplate === 'function'],
  ['root humanoid skeleton template extractor ESM', typeof root.extractHumanoidSkeletonTemplateFromModel === 'function'],
  ['root humanoid skeleton template extractor CJS', typeof rootCjs.extractHumanoidSkeletonTemplateFromModel === 'function'],
  ['core ESM object', typeof core === 'object'],
  ['core CJS object', typeof coreCjs === 'object'],
];

const failures = checks.filter(([, passed]) => !passed);
if (failures.length > 0) {
  for (const [label] of failures) {
    console.error(`Package export smoke failed: ${label}`);
  }
  process.exit(1);
}

console.log('Package export smoke passed');
