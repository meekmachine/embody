import assert from 'node:assert/strict';
import {
  AnimationClip,
  AnimationMixer,
  Bone,
  BufferGeometry,
  Group,
  InterpolateDiscrete,
  InterpolateLinear,
  LoopOnce,
  Mesh,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import {
  createAnimationClipFromClipIR,
  serializeAnimationClips,
  ThreeModelInspector,
} from '../../dist/three.js';

const near = (actual, expected, label) => {
  assert(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
};
const model = new Group();
const bone = new Bone();
bone.name = 'Arm';
const prop = new Object3D();
prop.name = 'Prop';
const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
mesh.name = 'Face';
mesh.morphTargetDictionary = { Smile: 0 };
mesh.morphTargetInfluences = [0];
model.add(bone, prop, mesh);
const inspection = new ThreeModelInspector().inspectModel(model);
const axis = new Vector3(0, 1, 0);
const start = new Quaternion().setFromAxisAngle(axis, Math.PI / 6);
const end = new Quaternion().setFromAxisAngle(axis, Math.PI / 3);
const mixer = new AnimationMixer(model);

try {
  for (const [interpolation, name] of [[InterpolateDiscrete, 'step'], [InterpolateLinear, 'linear']]) {
    const authored = new AnimationClip(name, 1, [
      new QuaternionKeyframeTrack('Arm.quaternion', [0, 1], [...start.toArray(), ...end.toArray()], interpolation),
      new VectorKeyframeTrack('Arm.position', [0, 1], [0, 0, 0, 10, 0, 0], interpolation),
      new VectorKeyframeTrack('Prop.scale', [0, 1], [1, 1, 1, 3, 3, 3], interpolation),
      new NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 1], [0.2, 0.8], interpolation),
      new NumberKeyframeTrack('Face.visible', [0, 1], [1, 0], interpolation),
    ]);
    const original = AnimationClip.toJSON(authored);
    const [ir] = serializeAnimationClips(model, [authored], inspection);
    assert.equal(ir.tracks.length, authored.tracks.length);
    assert(ir.tracks.every((track) => track.interpolation === name));
    const unchanged = structuredClone(ir);

    // Conversion is independent of the currently rendered pose. Nonzero authored
    // starts must not be normalized against frame zero or the target's quaternion.
    bone.quaternion.setFromAxisAngle(axis, 2);
    const clip = createAnimationClipFromClipIR(ir, inspection);
    assert.equal(clip.tracks.length, authored.tracks.length);
    assert(clip.tracks.every((track) => track.getInterpolation() === interpolation));
    assert.deepEqual(Array.from(clip.tracks[0].values), Array.from(authored.tracks[0].values));
    const action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    mixer.update(0);
    assert(bone.quaternion.angleTo(start) < 1e-3, 'authored starting rotation is preserved');
    mixer.update(0.5);
    const fraction = name === 'step' ? 0 : 0.5;
    assert(bone.quaternion.angleTo(start.clone().slerp(end, fraction)) < 1e-3, `${name} quaternion midpoint`);
    near(bone.position.x, fraction * 10, `${name} position midpoint`);
    near(prop.scale.x, 1 + fraction * 2, `${name} scale midpoint`);
    near(mesh.morphTargetInfluences[0], 0.2 + fraction * 0.6, `${name} morph midpoint`);
    near(Number(mesh.visible), 1 - fraction, `${name} visibility midpoint`);
    mixer.update(0.5);
    assert(bone.quaternion.angleTo(end) < 1e-3, `${name} quaternion endpoint`);
    near(bone.position.x, 10, `${name} position endpoint`);
    near(prop.scale.x, 3, `${name} scale endpoint`);
    near(mesh.morphTargetInfluences[0], 0.8, `${name} morph endpoint`);
    near(Number(mesh.visible), 0, `${name} visibility endpoint`);
    action.stop();
    mixer.uncacheClip(clip);
    assert.deepEqual(ir, unchanged, 'materialization does not mutate ClipIR');
    assert.deepEqual(AnimationClip.toJSON(authored), original, 'serialization does not mutate the source clip');
  }

  const boneId = [...inspection.boneBindings].find(([, value]) => value === bone)[0];
  const defaultClip = createAnimationClipFromClipIR({
    name: 'default-linear',
    tracks: [{ target: { kind: 'boneTransform', boneId, property: 'position' }, valueType: 'vec3', times: [0, 1], values: [0, 0, 0, 10, 0, 0] }],
  }, inspection);
  assert.equal(defaultClip.tracks[0].getInterpolation(), InterpolateLinear);
  near(defaultClip.tracks[0].createInterpolant().evaluate(0.5)[0], 5, 'omitted interpolation remains linear');
} finally {
  mixer.stopAllAction();
  mesh.geometry.dispose();
  mesh.material.dispose();
}

console.log('Clip step/linear round-trip and mixer smoke passed');
