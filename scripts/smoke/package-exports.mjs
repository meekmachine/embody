import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import {
  AnimationClip,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  Object3D,
  QuaternionKeyframeTrack,
  VectorKeyframeTrack,
} from 'three';

const require = createRequire(import.meta.url);
const serviceWorkerPath = require.resolve(
  '@lovelace_lol/embody/character-asset-service-worker.js',
);
const wasmPackagePath = require.resolve('@lovelace_lol/embody/wasm');
const serviceWorkerSource = await readFile(serviceWorkerPath, 'utf8');
const root = await import('@lovelace_lol/embody');
const three = await import('@lovelace_lol/embody/three');
const wasm = await import('@lovelace_lol/embody/wasm');

const core = await wasm.initEmbodyCore();
const distEntries = await readdir(new URL('../../dist/', import.meta.url));
const wasmEntrySource = await readFile(new URL('../../dist/wasm.js', import.meta.url), 'utf8');
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
const morphGeometry = new BufferGeometry();
morphGeometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
morphGeometry.setAttribute('normal', new BufferAttribute(new Float32Array(9), 3));
morphGeometry.morphTargetsRelative = true;
morphGeometry.morphAttributes.position = [new BufferAttribute(new Float32Array(9), 3)];
morphGeometry.morphAttributes.normal = [new BufferAttribute(new Float32Array(9), 3)];
morphGeometry.morphAttributes.color = [];
const morphMesh = new Mesh(morphGeometry);
morphMesh.name = 'CC_Base_Body_1';
morphMesh.morphTargetDictionary = { Existing: 0 };
morphMesh.morphTargetInfluences = [0];
const morphRoot = new Object3D();
morphRoot.add(morphMesh);
new three.ThreeFrameApplier().addMorphTarget(morphRoot, {
  meshName: morphMesh.name,
  name: 'Authored_Position_Only',
  relative: true,
  position: new Float32Array(9),
});

const checks = [
  ['root ESM Three adapter', typeof root.ThreeModelInspector === 'function'],
  ['Three ESM frame applier', typeof three.ThreeFrameApplier === 'function'],
  ['Wasm ESM ABI', core.core_abi_version() === wasm.EMBODY_CORE_ABI_VERSION],
  ['package has no CommonJS bundles', !distEntries.some((entry) => entry.endsWith('.cjs'))],
  ['Wasm package path resolves to ESM', wasmPackagePath.endsWith('/dist/wasm.js')],
  ['Wasm loader avoids eval/new Function', !wasmEntrySource.includes('new Function')],
  ['Wasm loader uses native dynamic import', wasmEntrySource.includes('import(')],
  ['embedded profile data', preset.meshes.CC_Base_Eye.category === 'eye'],
  ['Rust hair appearance data', hairPresets.natural_brown.baseColor === '#4a3728'],
  ['CC4 preset owns hair color swatches', preset.hairColorPresets?.natural_brown?.baseColor === '#4a3728'],
  ['Rust humanoid template data', templates[0].id === 'cc4-humanoid'],
  ['Rust model extraction', extracted.morphs[0].meshName === 'Face'],
  ['Rust runtime constructor', runtime.active_transition_count() === 0],
  ['baked clip channel classification', serialized.channels.map(({ kind }) => kind).join(',') === 'body,scene'],
  ['baked clip channel routing', serialized.tracks.map(({ channelId }) => channelId).join(',') === '1,2'],
  ['position-only authored morph keeps normal channel aligned', morphMesh.geometry.morphAttributes.normal.length === 2],
  ['position-only authored morph creates a neutral normal', morphMesh.geometry.morphAttributes.normal[1]?.array.every((value) => value === 0)],
  ['position-only authored morph keeps influences aligned', morphMesh.morphTargetInfluences.length === 2],
  ['position-only authored morph removes empty channels', morphMesh.geometry.morphAttributes.color === undefined],
  [
    'character asset service worker export',
    serviceWorkerSource.includes("addEventListener('fetch'") &&
      serviceWorkerSource.includes('embody-character-assets-'),
  ],
];

runtime.free();
const failures = checks.filter(([, passed]) => !passed);
if (failures.length) {
  failures.forEach(([label]) => console.error(`Package export smoke failed: ${label}`));
  process.exit(1);
}
console.log('Package export smoke passed');
