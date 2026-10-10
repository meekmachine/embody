import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AnimationClip, AnimationMixer, AnimationUtils, Bone, BufferGeometry, Group,
  LoopOnce, Mesh, MeshBasicMaterial, Quaternion, QuaternionKeyframeTrack, Vector3,
} from 'three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import { ThreeClipSlots, ThreeModelInspector, createAnimationClipFromClipIR } from '@lovelace_lol/embody/three';

// CI runs this against its already-built public package. A real Wasm compiler
// and AnimationMixer are required here: inspecting semantic AU requests alone
// cannot expose action dilution, stranded morphs, or quaternion ordering bugs.
// No browser, render loop, or agency clock is installed by this fixture.
const wasm = await initEmbodyCore();
const profile = JSON.parse(await readFile(new URL('../../assets/presets/cc4.json', import.meta.url)));
// Asymmetric authored limits make a hardcoded ±60/±30 range visibly incorrect.
// Every tested AU also has a morph destination, so a bone-only implementation
// cannot pass by rendering the expected rotation while dropping other outputs.
profile.auToBones['51'][0].maxDegrees = 71;
profile.auToBones['52'][0].maxDegrees = 29;
profile.auToBones['53'][0].maxDegrees = 37;
profile.auToBones['54'][0].maxDegrees = 19;
const ids = [51, 52, 53, 54, 55, 56, 61, 62, 63, 64];
profile.morphToMesh.face = ['Face'];
for (const id of ids) profile.auToMorphs[id] = { center: [`AU${id}`] };
const model = new Group();
// The head starts away from identity. Correct additive conversion must remove
// that authored reference once, not mistake an endpoint for a rotation delta.
// CC4 eyes keep their local Rx(-90°) rest, whose optical forward axis is -Y.
const head = new Bone(); head.name = 'CC_Base_Head'; head.rotation.set(0.1, -0.2, 0.15);
const left = new Bone(); left.name = 'CC_Base_L_Eye';
const right = new Bone(); right.name = 'CC_Base_R_Eye';
left.rotation.x = right.rotation.x = -Math.PI / 2;
head.add(left, right); model.add(head);
const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial()); mesh.name = 'Face';
mesh.morphTargetDictionary = Object.fromEntries(ids.map((id, index) => [`AU${id}`, index]));
mesh.morphTargetInfluences = ids.map(() => 0); model.add(mesh);
const rest = head.quaternion.clone();
const inspection = new ThreeModelInspector().inspectModel(model, { profile });
const core = new wasm.RuntimeCore(0);
core.configure_with_profile(JSON.stringify(profile), JSON.stringify(inspection.descriptor));
const mixer = new AnimationMixer(model);
const events = [];
const slots = new ThreeClipSlots(mixer, event => events.push(event));
const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 2e-6, `${label}: ${actual} != ${expected}`);
const poseNear = (actual, expected, label) => assert(actual.angleTo(expected) < 0.0001, label);
// Three's finished event precedes binding application. Draining microtasks
// models the helper's post-update lifecycle delivery without a second clock;
// tick advances the sole native mixer by an explicit duration in seconds.
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const tick = async seconds => { mixer.update(seconds); await flush(); };
const compile = (values, name = 'target') => {
  // Compile the complete semantic target and its zero-intensity reference
  // through the same core/profile. Do not hand-author quaternion/morph targets
  // or derive neutral from the animated scene: either would bypass the contract.
  const channels = Object.entries(values).map(([id, intensity]) => ({
    target: { type: 'au', id: Number(id) },
    keyframes: [{ time: 0, intensity }, { time: 1, intensity }],
  }));
  const ir = JSON.parse(core.build_typed_clip(name, JSON.stringify(channels), JSON.stringify({ allowEmpty: true })));
  const zero = channels.map(channel => ({ ...channel, keyframes: channel.keyframes.map(key => ({ ...key, intensity: 0 })) }));
  const neutral = JSON.parse(core.build_typed_clip(`${name}/neutral`, JSON.stringify(zero), JSON.stringify({ allowEmpty: true })));
  return { ir, clip: createAnimationClipFromClipIR(ir, inspection), referenceClip: createAnimationClipFromClipIR(neutral, inspection) };
};
const replace = (name, values, durationSec = 0.1) => {
  const compiled = compile(values, name);
  return { ...compiled, handle: slots.replace(name, compiled.clip, { durationSec, referenceClip: compiled.referenceClip }) };
};
const assertCanonical = (ir, label) => {
  // Compare actual renderer properties with canonical compiled endpoints.
  // Morph mix defaults belong to the profile/compiler, so the oracle is its
  // concrete IR value rather than an assumed 1:1 AU intensity. Also inspect
  // properties absent from the new IR: they must have released to zero.
  const morphValues = new Map();
  for (const track of ir.tracks) {
    if (track.target.kind === 'boneTransform') {
      poseNear(inspection.boneBindings.get(track.target.boneId).quaternion,
        new Quaternion().fromArray(track.values.slice(-4)), `${label}: mapped bone`);
    } else if (track.target.kind === 'morphTarget') {
      const binding = inspection.morphBindings.get(track.target.morphTargetId);
      near(binding.mesh.morphTargetInfluences[binding.index], track.values.at(-1), `${label}: mapped morph`);
      morphValues.set(binding.index, track.values.at(-1));
    }
  }
  mesh.morphTargetInfluences.forEach((value, index) => near(value, morphValues.get(index) ?? 0, `${label}: outgoing morph releases`));
};

try {
  // Unit AU and zero contribution must both reach and hold their exact mapped
  // endpoints. Extra elapsed mixer time cannot decay a held target or require
  // a scheduler seek to keep it visible after native completion.
  for (const id of [51, 52, 53, 54]) for (const strength of [0, 1]) {
    slots.clear();
    const { ir, handle } = replace('tracking/head', { [id]: strength });
    await tick(0.1);
    assert.equal((await handle.finished).type, 'completed');
    assertCanonical(ir, `signed AU${id} at ${strength}`);
    await tick(2);
    assertCanonical(ir, 'target holds without agency seeks');
  }

  slots.clear();
  // Replace a partially travelled target with a much faster opposite one.
  // Continuity is checked synchronously at admission; canonical equality is
  // checked at the new deadline, including release of the outgoing morph.
  replace('tracking/head', { 51: 1 }, 1);
  await tick(0.1);
  const before = head.quaternion.clone();
  const fast = replace('tracking/head', { 52: 1 }, 0.1);
  poseNear(head.quaternion, before, 'retarget preserves the exact current contribution');
  await tick(0.1);
  assertCanonical(fast.ir, 'shorter replacement retires every old contribution');

  // Repeat after an immediate held target, then interrupt the return journey.
  // The shorter replacement must capture the actual current contribution, not
  // the old endpoint or a residual action whose longer lifetime can overshoot.
  replace('tracking/head', { 51: 1 }, 0);
  replace('tracking/head', { 52: 1 }, 1);
  await tick(0.1);
  const beforeShortening = head.quaternion.clone();
  const shortened = replace('tracking/head', { 51: 1 }, 0.1);
  poseNear(head.quaternion, beforeShortening, 'shortening a previous movement has no command-boundary jump');
  await tick(0.1);
  assertCanonical(shortened.ir, 'older one-second movement cannot remain above a full new AU');

  // Repeated replacements in one mixer tick inherit the preceding concrete
  // start rather than restarting from neutral or leaking previous actions.
  const beforeRapid = head.quaternion.clone();
  for (let i = 0; i < 20; i++) replace('tracking/head', { [i % 2 ? 51 : 52]: 1 }, 0.2);
  poseNear(head.quaternion, beforeRapid, 'same-tick replacements are continuous');
  await tick(0.2);
  assertCanonical(compile({ 51: 1 }).ir, 'rapid replacement settles at one full AU');
  // The earlier fade-chain design attenuated a target under repeated input and
  // could retain old actions. Varying duration while the target stays full must
  // preserve both endpoint magnitude and one-action-per-slot ownership.
  for (let i = 0; i < 80; i++) {
    replace('tracking/head', { 51: 1 }, i % 2 ? 0.8 : 0.15);
    await tick(0.01);
    assertCanonical(compile({ 51: 1 }).ir, 'continuous retargeting cannot attenuate a full target');
    assert.equal(mixer.stats.actions.inUse, 1, 'one native action per slot regardless of replacements');
  }


  // Paused local time must remain frozen while the mixer continues advancing
  // unrelated work. Resume completes only the remaining native clip duration.
  replace('tracking/head', { 54: 1 }, 0.4);
  await tick(0.1);
  slots.pauseAll();
  const paused = head.quaternion.clone();
  await tick(3);
  poseNear(head.quaternion, paused, 'pause freezes native target clip time');
  slots.resumeAll();
  await tick(0.3);
  assertCanonical(compile({ 54: 1 }).ir, 'resume completes only the remaining travel');

  // Tracking remains an ordinary additive contribution beside an authored
  // Prosodic nod; retiring another action must not reorder their quaternions.
  // The expected product is authored nod * inverse(rest) * compiled gaze pose.
  // Reversing those factors, capturing the combined scene as the new start, or
  // averaging separate yaw/pitch/roll actions changes the visible result.
  slots.clear();
  const nodRotation = rest.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.2));
  const nod = new AnimationClip('prosodic/nod', 1, [new QuaternionKeyframeTrack(`${head.uuid}.quaternion`, [0, 1], [...nodRotation.toArray(), ...nodRotation.toArray()])]);
  const reference = new AnimationClip('neutral', 1, [new QuaternionKeyframeTrack(`${head.uuid}.quaternion`, [0], rest.toArray())]);
  AnimationUtils.makeClipAdditive(nod, 0, reference, 30);
  const nodAction = mixer.clipAction(nod).setLoop(LoopOnce, 1); nodAction.clampWhenFinished = true; nodAction.play();
  const target = replace('tracking/head', { 51: 1, 53: 0.3, 55: 0.2 }, 0.1);
  await tick(0.1);
  const targetQuaternion = new Quaternion().fromArray(target.ir.tracks.find(track => track.target.kind === 'boneTransform').values.slice(-4));
  poseNear(head.quaternion, nodRotation.clone().multiply(rest.clone().invert().multiply(targetQuaternion)), 'nod and three-axis head target compose');
  slots.remove('tracking/head');
  poseNear(head.quaternion, nodRotation, 'removing tracking preserves the authored nod');
  // Disposal must also reveal a surviving same-property action immediately.
  // Without the helper's zero-delta mixer application, stop() leaves the prior
  // combined pose visible while the nod still owns the property binding.
  const temporary = new ThreeClipSlots(mixer);
  temporary.replace('tracking/head', target.clip, { durationSec: 0, referenceClip: target.referenceClip });
  temporary.dispose();
  poseNear(head.quaternion, nodRotation, 'dispose restores surviving nod without another frame');
  nodAction.stop(); mixer.uncacheClip(nod);

  // Bilateral eye mappings and both rotation axes go through one ordinary clip,
  // preserving the compiler's ordered result on each configured eye bone.
  const eyeTarget = replace('tracking/eyes', { 61: 0.3, 63: 0.7 });
  await tick(0.1);
  assertCanonical(eyeTarget.ir, 'eye yaw and pitch compile together');
  slots.clear();

  // Opt-in no-output targets preserve cleared mappings and retire prior output.
  // An empty profile is intentional here, not a reason to borrow CC4 mappings.
  // The default API still rejects unresolved output; allowEmpty explicitly lets
  // a slot transition its previously owned tracks back to additive identity.
  const emptyCore = new wasm.RuntimeCore(0);
  emptyCore.configure_with_profile('{}', JSON.stringify(inspection.descriptor));
  assert.throws(() => emptyCore.build_clip('unmapped', '{"51":[{"time":0,"intensity":1}]}', '{}'), /No runtime tracks/);
  const emptyIR = JSON.parse(emptyCore.build_clip('unmapped', '{"51":[{"time":0,"intensity":1}]}', '{"allowEmpty":true}'));
  assert.deepEqual(emptyIR.tracks, []);
  replace('tracking/head', { 51: 1 }, 0);
  const empty = slots.replace('tracking/head', createAnimationClipFromClipIR(emptyIR, inspection), { durationSec: 0.1, referenceClip: new AnimationClip('empty-neutral', 0, []) });
  await tick(0.1);
  assert.equal((await empty.finished).type, 'completed');
  poseNear(head.quaternion, rest, 'empty mapped target releases prior pose');
  emptyCore.free();

  // A late cancellation carries an old handle, so it must not remove the
  // current generation that reused the slot name. Full disposal, in contrast,
  // resolves current pending work, releases its pose, and closes admission.
  const obsolete = replace('tracking/head', { 51: 1 }, 0.2).handle;
  const latest = replace('tracking/head', { 52: 1 }, 0.2);
  obsolete.stop();
  await tick(0.2);
  assertCanonical(latest.ir, 'obsolete handle cannot stop a replacement');
  const pending = replace('tracking/head', { 51: 1 }, 2).handle;
  slots.dispose();
  assert.equal((await pending.finished).type, 'disposed');
  poseNear(head.quaternion, rest, 'dispose releases all slot actions');
  assert.throws(() => replace('tracking/head', { 51: 1 }), /disposed/);
} finally {
  // Keep the fixture's explicit owners symmetrical even if an assertion fails.
  // Repeated disposal is allowed; the external mixer and Wasm core are separate
  // resources and are released by this caller rather than by the slot helper.
  slots.dispose(); mixer.stopAllAction(); core.free(); mesh.geometry.dispose(); mesh.material.dispose();
}
console.log('Native AU target clip lifecycle smoke passed');
