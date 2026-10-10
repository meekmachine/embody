import assert from 'node:assert/strict';
import { AnimationMixer, Bone, Euler, Group, LoopOnce, Quaternion } from 'three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import { createAnimationClipFromClipIR, ThreeModelInspector } from '@lovelace_lol/embody/three';

// Verify the published package boundary and real mixer, including a rig whose
// reference rotation is not identity. No build or scene mutation during compile.
const wasm = await initEmbodyCore();
const model = new Group();
const hand = new Bone(); hand.name = 'joint_17';
const other = new Bone(); other.name = 'joint_29';
hand.rotation.set(0.4, -0.2, 0.3);
other.rotation.set(-0.1, 0.2, 0.1);
model.add(hand, other);
const reference = hand.quaternion.clone();
const untouched = other.quaternion.clone();
const profile = {
  boneNodes: { LEFT_HAND: hand.name, alias: hand.name },
  auToBones: { 1: [{ node: 'LEFT_HAND', channel: 'rx', scale: 1, maxDegrees: 60 }] },
  compositeRotations: [{ node: 'LEFT_HAND', pitch: { aus: [1], axis: 'rx' } }],
};
const inspection = new ThreeModelInspector().inspectModel(model, { profile });
const core = new wasm.RuntimeCore(0);
core.configure_with_profile(JSON.stringify(profile), JSON.stringify(inspection.descriptor));
const mixer = new AnimationMixer(model);
const degrees = Math.PI / 180;
const orientation = (xyz) => new Quaternion().setFromEuler(new Euler(...xyz.map((value) => value * degrees), 'XYZ'));
const near = (actual, expected, label) => assert(actual.angleTo(expected) < 0.001, label);
const samples = [[-30, 20, 15], [0, 0, 0], [30, -20, -15]];
const channels = () => ['rx', 'ry', 'rz'].map((channel, axis) => ({
  target: { type: 'bone', id: 'LEFT_HAND', channel, rotationSpace: 'local', maxDegrees: 1 },
  keyframes: samples.map((sample, index) => ({ time: index / 2, intensity: sample[axis] })),
}));
const compile = (input, options = {}) => JSON.parse(core.build_typed_clip('gesture', JSON.stringify(input), JSON.stringify(options)));
const play = (ir, at, expected) => {
  const clip = createAnimationClipFromClipIR(ir, inspection);
  assert.equal(clip.tracks.length, 1, 'XYZ compiles to one concrete orientation track');
  const action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play(); mixer.update(at);
  near(hand.quaternion, expected, `local orientation at ${at}`);
  near(other.quaternion, untouched, 'unrelated bone stays unchanged');
  action.stop(); mixer.uncacheClip(clip);
  near(hand.quaternion, reference, 'stopping restores the mixer base');
};
try {
  const ir = compile(channels().reverse());
  assert.equal(ir.tracks.length, 1);
  near(hand.quaternion, reference, 'compilation is pure');
  for (const [index, sample] of samples.entries()) play(ir, index / 2, orientation(sample));
  play(ir, 0.25, orientation(samples[0]).slerp(orientation(samples[1]), 0.5));
  play(compile(channels(), { intensityScale: 0.5 }), 1, orientation(samples[2].map((value) => value / 2)));
  play(compile(channels().map((channel) => ({ ...channel, intensityScale: 0.5 }))), 1,
    orientation(samples[2].map((value) => value / 2)));
  const zeros = channels().map((channel) => ({ ...channel, keyframes: [{ time: 0, intensity: 0 }, { time: 1, intensity: 0 }] }));
  play(compile(zeros), 1, new Quaternion());
  const inherited = channels().map((channel) => ({ ...channel, keyframes: channel.keyframes.map((key, i) => ({ ...key, inherit: i === 0 })) }));
  play(compile(inherited), 0, reference);
  play(compile(inherited), 0.25, reference.clone().slerp(new Quaternion(), 0.5));

  // Legacy snippets remain reference-relative, with no automatic migration.
  const relative = channels()[0]; delete relative.target.rotationSpace;
  play(compile([relative]), 1, reference.clone().multiply(orientation([30, 0, 0])));
  assert.throws(() => compile(channels().slice(1)), /requires all three/);
  assert.throws(() => compile([...channels(), channels()[0]]), /duplicate axis/);
  const alias = channels()[0]; alias.target.id = 'alias';
  assert.throws(() => compile([...channels(), alias]), /duplicate axis/);
  const unequal = channels(); unequal[1].keyframes[1].time = 0.6;
  assert.throws(() => compile(unequal), /share key times/);
  const duplicate = channels(); duplicate.forEach((channel) => { channel.keyframes[1].time = 0; });
  assert.throws(() => compile(duplicate), /strictly increasing/);
  const mismatch = channels(); mismatch[1].keyframes[0].inherit = true;
  assert.throws(() => compile(mismatch), /inheritance flags/);
  const badInherit = channels(); badInherit.forEach((channel) => { channel.keyframes[1].inherit = true; });
  assert.throws(() => compile(badInherit), /only the first sample/);
  assert.throws(() => compile([...channels(), relative]), /overlaps another rotation/);
  assert.throws(() => compile([...channels(), { target: { type: 'au', id: 1 }, keyframes: [{ time: 0, intensity: 0 }, { time: 1, intensity: 1 }] }]), /overlaps another rotation/);
  const missing = channels(); missing[0].target.id = 'unknown';
  assert.throws(() => compile(missing), /could not be resolved/);
  const invalid = channels(); invalid[0].target.rotationSpace = 'world';
  assert.throws(() => compile(invalid), /rotationSpace must/);
  const position = channels(); position[0].target.channel = 'tx';
  assert.throws(() => compile(position), /channels only/);
  const overflow = channels(); overflow[0].target.maxDegrees = 1e300;
  assert.throws(() => compile(overflow), /angles must be finite/);
  console.log('Absolute local bone rotations: package and mixer checks passed.');
} finally {
  mixer.stopAllAction();
  core.free();
}
