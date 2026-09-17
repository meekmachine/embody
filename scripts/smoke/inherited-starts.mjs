import assert from 'node:assert/strict';
import {
  AnimationMixer,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LoopOnce,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
} from 'three';
import { initEmbodyCore } from '../../dist/wasm.js';
import {
  createAnimationClipFromClipIR,
  ThreeFrameApplier,
  ThreeModelInspector,
} from '../../dist/three.js';

// Exercise the built Wasm ABI and actual Three interpolation, not a mocked
// compiler or adapter. This script consumes the existing build only.
const wasm = await initEmbodyCore();
const model = new Group();
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
const mesh = new Mesh(geometry, new MeshBasicMaterial());
mesh.name = 'Face';
mesh.morphTargetDictionary = { Smile: 0, Talk: 1, Custom: 2 };
mesh.morphTargetInfluences = [0, 0, 0];
const bone = new Bone();
bone.name = 'Head';
const object = new Object3D();
object.name = 'Prop';
model.add(mesh, bone, object);
const profile = {
  auToMorphs: { 200: { center: ['Smile'], left: [], right: [] } },
  morphToMesh: { face: ['Face'] },
  visemeKeys: ['Talk'],
};
const inspection = new ThreeModelInspector().inspectModel(model, { profile });
const core = new wasm.RuntimeCore(0);
core.configure_with_profile(JSON.stringify(profile), JSON.stringify(inspection.descriptor));
const applier = new ThreeFrameApplier();
applier.setBindings(inspection);
const mixer = new AnimationMixer(model);
const near = (actual, expected, label) => {
  assert(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
};
const start = (clipIR) => {
  const clip = createAnimationClipFromClipIR(clipIR, inspection);
  const action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.update(0);
  return {
    clip,
    stop() { action.stop(); mixer.uncacheClip(clip); },
  };
};
const curve = (time = 0, inherit = true) => [
  { time, intensity: 0, inherit },
  { time: 1, intensity: 1 },
];

try {
  for (const [curveId, index, options] of [
    ['200', 0, {}],
    ['0', 1, { snippetCategory: 'visemeSnippet', autoVisemeJaw: false }],
    ['Custom', 2, {}],
  ]) {
    // Capture a live rendered value; the compiler must retain an unresolved
    // placeholder so later playback can start from a different pose.
    core.set_au_signed(200, 0.8, 0);
    core.set_viseme(0, 0.8);
    applier.applyPackedMorphFrameDelta(core.evaluate_morph_frame_delta());
    mesh.morphTargetInfluences[2] = 0.8;
    const ir = JSON.parse(core.build_clip(curveId, JSON.stringify({ [curveId]: curve() }), JSON.stringify(options)));
    assert.equal(ir.tracks.length, 1);
    assert.equal(ir.tracks[0].inheritStart, true, `${curveId} preserves inheritance`);
    const unchanged = structuredClone(ir);
    const playing = start(ir);
    near(mesh.morphTargetInfluences[index], 0.8, `${curveId} live start`);
    mixer.update(0.5);
    near(mesh.morphTargetInfluences[index], 0.9, `${curveId} midpoint`);
    mixer.update(0.5);
    near(mesh.morphTargetInfluences[index], 1, `${curveId} endpoint`);
    playing.stop();

    mesh.morphTargetInfluences[index] = 0.2;
    const replay = start(ir);
    near(mesh.morphTargetInfluences[index], 0.2, `${curveId} replay samples a new start`);
    near(playing.clip.tracks[0].values[0], 0.8, `${curveId} previous clip is unchanged`);
    mixer.update(0.5);
    near(mesh.morphTargetInfluences[index], 0.6, `${curveId} replay midpoint`);
    replay.stop();
    assert.deepEqual(ir, unchanged, 'materialization never changes cached ClipIR');
  }

  // Delayed inherited keys intentionally retain Loom3's hold semantics.
  mesh.morphTargetInfluences[0] = 0.8;
  const delayed = JSON.parse(core.build_clip('delayed', JSON.stringify({ 200: curve(0.5) }), '{}'));
  const playing = start(delayed);
  mixer.update(0.25);
  near(mesh.morphTargetInfluences[0], 0.8, 'delayed key holds before its timestamp');
  mixer.update(0.5);
  near(mesh.morphTargetInfluences[0], 0.9, 'delayed key interpolates after its timestamp');
  playing.stop();

  const fixed = curve(0, false);
  fixed[1].inherit = true; // Only the first key controls start inheritance.
  const authored = JSON.parse(core.build_clip('authored', JSON.stringify({ 200: fixed }), '{}'));
  assert.equal(authored.tracks[0].inheritStart, undefined);
  mesh.morphTargetInfluences[0] = 0.8;
  const authoredPlaying = start(authored);
  near(mesh.morphTargetInfluences[0], 0, 'non-inherited authored start is preserved');
  authoredPlaying.stop();

  const morphId = [...inspection.morphBindings].find(([, binding]) => binding.index === 0)[0];
  const generic = JSON.parse(wasm.compile_clip_curves(JSON.stringify({
    name: 'generic',
    curves: { smile: curve() },
    intensityScale: 0.5,
    targets: { smile: { target: { kind: 'morphTarget', morphTargetId: morphId }, scale: 0.5 } },
  })));
  assert.equal(generic.tracks[0].inheritStart, true);
  mesh.morphTargetInfluences[0] = 0.8;
  const genericPlaying = start(generic);
  near(mesh.morphTargetInfluences[0], 0.8, 'live start is not rescaled');
  mixer.update(1);
  near(mesh.morphTargetInfluences[0], 0.25, 'authored endpoint retains scaling');
  genericPlaying.stop();

  // Zero intensity still needs a track to release an inherited live pose.
  mesh.morphTargetInfluences[0] = 0.8;
  const zeroScale = JSON.parse(core.build_clip('zero-scale', JSON.stringify({ 200: curve() }), '{"intensityScale":0}'));
  assert.deepEqual(zeroScale.tracks[0].values, [0, 0]);
  const zeroPlaying = start(zeroScale);
  near(mesh.morphTargetInfluences[0], 0.8, 'zero-scaled curve inherits live start');
  mixer.update(0.5);
  near(mesh.morphTargetInfluences[0], 0.4, 'zero-scaled curve fades inherited pose');
  mixer.update(0.5);
  near(mesh.morphTargetInfluences[0], 0, 'zero-scaled curve releases inherited pose');
  zeroPlaying.stop();
  assert.throws(
    () => core.build_clip('zero-authored', JSON.stringify({ 200: curve(0, false) }), '{"intensityScale":0}'),
    /No runtime tracks could be resolved/,
    'non-inherited zero-scale tracks remain omitted',
  );

  // Concrete transform tracks use the rendered local transform, not the rest
  // transform saved by model inspection. Test quaternion interpolation too.
  const boneId = [...inspection.boneBindings].find(([, value]) => value === bone)[0];
  const objectId = [...inspection.objectBindings].find(([, value]) => value === object)[0];
  const destination = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, 1);
  const initial = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.4);
  bone.quaternion.copy(initial);
  object.position.set(2, 4, 6);
  object.scale.set(2, 2, 2);
  const transformIR = JSON.parse(wasm.compile_clip(JSON.stringify({
    name: 'transforms',
    tracks: [
      { target: { kind: 'boneTransform', boneId, property: 'rotation' }, valueType: 'quat',
        keyframes: [{ time: 0, value: [0, 0, 0, 1], inherit: true }, { time: 1, value: destination.toArray() }] },
      { target: { kind: 'objectTransform', objectId, property: 'position' }, valueType: 'vec3',
        keyframes: [{ time: 0, value: [0, 0, 0], inherit: true }, { time: 1, value: [4, 6, 8] }] },
      { target: { kind: 'objectTransform', objectId, property: 'scale' }, valueType: 'vec3',
        keyframes: [{ time: 0, value: [1, 1, 1], inherit: true }, { time: 1, value: [4, 4, 4] }] },
    ],
  })));
  const transforms = start(transformIR);
  bone.quaternion.toArray().forEach((value, i) => near(value, initial.toArray()[i], 'quaternion live start'));
  assert.deepEqual(object.position.toArray(), [2, 4, 6]);
  assert.deepEqual(object.scale.toArray(), [2, 2, 2]);
  mixer.update(0.5);
  const midpoint = initial.clone().slerp(destination, 0.5);
  bone.quaternion.toArray().forEach((value, i) => near(value, midpoint.toArray()[i], 'quaternion midpoint'));
  assert.deepEqual(object.position.toArray(), [3, 5, 7]);
  assert.deepEqual(object.scale.toArray(), [3, 3, 3]);
  transforms.stop();
} finally {
  mixer.stopAllAction();
  core.free();
  geometry.dispose();
  mesh.material.dispose();
}

console.log('Inherited-start Wasm/Three smoke passed');
