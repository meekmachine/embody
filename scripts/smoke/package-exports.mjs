import { createRequire } from 'node:module';
import { AnimationClip, Bone, Object3D, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';

const require = createRequire(import.meta.url);
const root = await import('@lovelace_lol/embody');
const three = await import('@lovelace_lol/embody/three');
const wasm = await import('@lovelace_lol/embody/wasm');
const rootCjs = require('@lovelace_lol/embody');
const threeCjs = require('@lovelace_lol/embody/three');
const wasmCjs = require('@lovelace_lol/embody/wasm');

const core = await wasm.initEmbodyCore();
const cjsCore = await wasmCjs.initEmbodyCore();
const preset = JSON.parse(core.get_preset_json('cc4'));
const hairPresets = JSON.parse(core.hair_color_presets_json());
const templates = JSON.parse(core.list_humanoid_skeleton_templates_json());
const model = {
  meshes: [{ id: 1, name: 'Face', morphTargetIds: [1], visible: true }],
  morphTargets: [{ id: 1, meshId: 1, name: 'Smile', hostIndex: 0 }],
  bones: [{ id: 1, name: 'Head', parentName: null, worldPosition: { x: 0, y: 1, z: 0 }, depth: 0 }],
  objects: [],
};
const extracted = JSON.parse(core.extract_model_data_json(JSON.stringify(model), '[]'));
const runtime = new core.RuntimeCore(0);
runtime.configure_with_preset('cc4', '', JSON.stringify(model));
const sceneRoot = new Object3D();
const animatedBone = new Bone();
const animatedProp = new Object3D();
animatedBone.name = 'Head';
animatedProp.name = 'Prop';
sceneRoot.add(animatedBone, animatedProp);
const inspection = new three.ThreeModelInspector().inspectModel(sceneRoot);
const serialized = three.serializeAnimationClips(sceneRoot, [new AnimationClip('mixed', 1, [
  new QuaternionKeyframeTrack('Head.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  new VectorKeyframeTrack('Prop.position', [0, 1], [0, 0, 0, 1, 2, 3]),
])], inspection)[0];

const checks = [
  ['root ESM Three adapter', typeof root.ThreeModelInspector === 'function'],
  ['root CJS Three adapter', typeof rootCjs.ThreeModelInspector === 'function'],
  ['Three ESM frame applier', typeof three.ThreeFrameApplier === 'function'],
  ['Three CJS scene factory', typeof threeCjs.createDefaultCharacterScene === 'function'],
  ['Wasm ESM ABI', core.core_abi_version() === wasm.EMBODY_CORE_ABI_VERSION],
  ['Wasm CJS ABI', cjsCore.core_abi_version() === wasmCjs.EMBODY_CORE_ABI_VERSION],
  ['embedded profile data', preset.meshes.CC_Base_Eye.category === 'eye'],
  ['Rust hair appearance data', hairPresets.natural_brown.baseColor === '#4a3728'],
  ['Rust humanoid template data', templates[0].id === 'jonathan-cc-base'],
  ['Rust model extraction', extracted.morphs[0].meshName === 'Face'],
  ['Rust runtime constructor', runtime.active_transition_count() === 0],
  ['baked clip channel classification', serialized.channels.map(({ kind }) => kind).join(',') === 'body,scene'],
  ['baked clip channel routing', serialized.tracks.map(({ channelId }) => channelId).join(',') === '1,2'],
];

runtime.free();
const failures = checks.filter(([, passed]) => !passed);
if (failures.length) {
  failures.forEach(([label]) => console.error(`Package export smoke failed: ${label}`));
  process.exit(1);
}
console.log('Package export smoke passed');
