import { renderHostFrame } from './helpers/render-playback.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnimationClip, Bone, BufferGeometry, Group, Mesh, MeshBasicMaterial,
  NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack,
} from 'three';
import { createRustEmbodyHost } from '@lovelace_lol/embody/three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

await initEmbodyCore();
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-5,
  `${message}: expected ${expected}, received ${actual}`);
const rotation = radians => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), radians);
const profile = {
  auToMorphs: {
    200: { center: ['A'], left: [], right: [] },
    201: { center: ['B'], left: [], right: [] },
    202: { center: ['A'], left: [], right: [] },
  },
  morphToMesh: { face: ['Face'] },
  visemeKeys: ['A', 'B'],
  boneNodes: { HEAD: 'Head' },
  auToBones: {
    210: [{ node: 'HEAD', channel: 'rz', scale: 1, maxDegrees: 30 }],
    211: [{ node: 'HEAD', channel: 'tx', scale: 1, maxUnits: 2 }],
  },
  compositeRotations: [{ node: 'HEAD', pitch: { aus: [210], axis: 'rz' }, yaw: null, roll: null }],
  hairPhysics: { enabled: false },
};

function makeModel(base = 0) {
  const model = new Group();
  const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.name = 'Face';
  mesh.morphTargetDictionary = { A: 0, B: 1, Unmapped: 2 };
  mesh.morphTargetInfluences = [base, 0, 0.35];
  const bone = new Bone();
  bone.name = 'Head';
  const unbound = new Bone();
  unbound.name = 'Unbound';
  model.add(mesh, bone, unbound);
  return { model, mesh, bone };
}

async function fixture(base = 0) {
  const { model, mesh, bone } = makeModel(base);
  const host = await createRustEmbodyHost(model, { profileMode: 'profile', profile });
  let disposed = false;
  return {
    model, mesh, bone, host,
    play(tracks, name = 'underlying', options = {}) {
      const clip = new AnimationClip(name, 2, tracks);
      host.loadAnimationClips([clip]);
      host.playAnimation(name, { loop: true, fadeInSec: 0, ...options });
      return name;
    },
    dispose() {
      if (!disposed) { host.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); disposed = true; }
    },
  };
}
const morphTrack = (index, values = [0.8, 0.8]) =>
  new NumberKeyframeTrack(`Face.morphTargetInfluences[${index}]`, [0, 2], values);
const positionTrack = () => new VectorKeyframeTrack('Head.position', [0, 2], [3, 4, 5, 3, 4, 5]);
const rotationTrack = () => {
  const values = rotation(0.9).toArray();
  return new QuaternionKeyframeTrack('Head.quaternion', [0, 2], [...values, ...values]);
};
const assertRotation = (bone, angle, message) => {
  near(bone.quaternion.lengthSq(), 1, `${message}: quaternion length squared`);
  // Native tracks store Float32 samples; compare unit copies without changing the scene.
  near(bone.quaternion.clone().normalize().angleTo(rotation(angle).normalize()), 0, message);
};

test('direct viseme getters expose accepted targets without sampling or changing rendered state', async () => {
  const rig = await fixture();
  try {
    rig.host.setViseme(0, 0.6, 0.25);
    rig.host.setViseme(1, 0.3, 0.75);
    renderHostFrame(rig.host, 0);
    const pose = [...rig.mesh.morphTargetInfluences];
    near(rig.host.getViseme(0), 0.6, 'direct target');
    near(rig.host.getVisemeJawScale(0), 0.25, 'jaw scale');
    assert.deepEqual(rig.mesh.morphTargetInfluences, pose, 'reads do not sample a frame');
    const transition = rig.host.transitionViseme(0, 0.5, 200, 0.4);
    near(rig.host.getViseme(0), 0.5, 'transition accepts the target immediately');
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'native transition starts from the previous sample');
    renderHostFrame(rig.host, 0.1);
    near(rig.mesh.morphTargetInfluences[0], 0.55, 'native linear midpoint');
    near(rig.mesh.morphTargetInfluences[1], 0.3, 'unrelated viseme remains');
    renderHostFrame(rig.host, 0.1);
    near(rig.mesh.morphTargetInfluences[0], 0.5, 'native transition reaches its endpoint');
    await transition.promise;
    rig.host.setViseme(0, 2, NaN);
    assert.equal(rig.host.getViseme(0), 1, 'Rust clamps intensity');
    assert.equal(rig.host.getVisemeJawScale(0), 1, 'Rust sanitizes jaw scale');
    rig.host.clear();
    assert.equal(rig.host.getViseme(0), 0);
    assert.equal(rig.host.getVisemeJawScale(0), 1);
  } finally { rig.dispose(); }
});

for (const setter of ['AU', 'viseme', 'morph']) {
  test(`unrelated ${setter} preserves clip channels and unmapped properties on native frames`, async () => {
    const rig = await fixture();
    try {
      rig.play([morphTrack(0)]);
      renderHostFrame(rig.host, 0.3);
      if (setter === 'AU') rig.host.setAU(201, 0.5);
      if (setter === 'viseme') rig.host.setViseme(1, 0.5);
      if (setter === 'morph') rig.host.setMorph('B', 0.5);
      renderHostFrame(rig.host, 0);
      near(rig.mesh.morphTargetInfluences[0], 0.8, 'unrelated clip remains');
      near(rig.mesh.morphTargetInfluences[1], 0.5, 'live track is sampled');
      near(rig.mesh.morphTargetInfluences[2], 0.35, 'unmapped morph stays untouched');
      renderHostFrame(rig.host, 0.1);
      near(rig.mesh.morphTargetInfluences[0], 0.8, 'later native samples remain intact');
    } finally { rig.dispose(); }
  });
}

test('live setters reject atomically while a changing clip owns the concrete target', async () => {
  const rig = await fixture();
  try {
    rig.play([morphTrack(0, [0.2, 1])]);
    renderHostFrame(rig.host, 0.25);
    const before = [...rig.mesh.morphTargetInfluences];
    for (const command of [() => rig.host.setAU(200, 0.9), () => rig.host.setViseme(0, 1),
      () => rig.host.setMorph('A', 1), () => rig.host.setAUMixWeight(200, 0.2)]) {
      assert.throws(command, error => error.code === 'LIVE_CONTROL_LOCKED' && error.availability.blockers[0].name === 'underlying');
    }
    assert.equal(rig.host.getAU(200), 0);
    assert.equal(rig.host.getViseme(0), 0);
    assert.equal(rig.host.getAUMixWeight(200), 1);
    assert.deepEqual(rig.mesh.morphTargetInfluences, before);
    renderHostFrame(rig.host, 0.25);
    near(rig.mesh.morphTargetInfluences[0], 0.4, 'native clip alone continues');
    rig.host.stopAnimation('underlying');
    rig.host.setAU(200, 0.9);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.9, 'release permits the next explicit live edit');
  } finally { rig.dispose(); }
});

for (const pause of ['none', 'action', 'mixer', 'finished-held']) {
  test(`live targets remain locked with ${pause} playback`, async () => {
    const rig = await fixture();
    try {
      rig.host.setAU(200, 0.4);
      const name = rig.play([morphTrack(0)], 'underlying', { loop: pause !== 'finished-held', finalPose: 'hold' });
      renderHostFrame(rig.host, 0.1);
      if (pause === 'action') rig.host.pauseAnimation(name);
      if (pause === 'mixer') rig.host.setAnimationTimeScale(0);
      if (pause === 'finished-held') renderHostFrame(rig.host, 2);
      assert.equal(rig.host.getLiveControlAvailability({ kind: 'au', id: 200 }).available, false);
      assert.throws(() => rig.host.setAU(200, 0), /driven by animation/);
      assert.equal(rig.host.getAU(200), 0.4, 'rejection retains the accepted live value');
      rig.host.stopAnimation(name);
      assert.equal(rig.host.getLiveControlAvailability({ kind: 'au', id: 200 }).available, true);
      rig.host.setAU(200, 0);
    } finally { rig.dispose(); }
  });
}

test('Rust aggregates semantic controls before live track application', async () => {
  const rig = await fixture();
  try {
    rig.host.setAU(200, 0.3);
    rig.host.setAU(202, 0.6);
    renderHostFrame(rig.host, 0.1);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'Rust resolves the maximum mapped AU contribution');
    rig.host.setAU(202, 0);
    rig.host.setViseme(0, 0.5);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.5, 'Rust resolves viseme and AU in one live contribution');
    rig.host.setMorph('A', 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0, 'explicit direct zero remains authoritative');
    near(rig.host.getAU(200), 0.3, 'direct morph leaves canonical AU state intact');
    rig.host.releaseMorph('A');
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.5, 'releasing direct target reveals semantic contribution');
    rig.host.setViseme(0, 0);
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0, 'releasing semantic targets restores the base');
  } finally { rig.dispose(); }
});

test('bone position and quaternion locks are concrete and release independently', async () => {
  const rig = await fixture();
  try {
    const name = rig.play([rotationTrack()]);
    renderHostFrame(rig.host, 0.1);
    assert.throws(() => rig.host.setAU(210, 1), /driven by animation/);
    rig.host.setAU(211, 0.5);
    renderHostFrame(rig.host, 0);
    assertRotation(rig.bone, 0.9, 'rotation remains with its action');
    near(rig.bone.position.x, 1, 'independent live translation remains editable');
    rig.host.pauseAnimation(name);
    assert.throws(() => rig.host.transitionAU(210, 0, 100), /driven by animation/);
    rig.host.stopAnimation(name);
    rig.host.setAU(210, 1);
    renderHostFrame(rig.host, 0);
    assertRotation(rig.bone, Math.PI / 6, 'native release permits live rotation');
  } finally { rig.dispose(); }
});

test('clear rejects before live state mutation and rebind retains accepted controls', async () => {
  const rig = await fixture();
  try {
    rig.host.setAU(200, 0.4);
    rig.host.setAU(210, 1);
    rig.play([morphTrack(0), rotationTrack()]);
    assert.throws(() => rig.host.clear(), /driven by animation/);
    assert.equal(rig.host.getAU(200), 0.4);
    assert.equal(rig.host.getAU(210), 1);
    rig.host.stopAllAnimations();
    rig.host.clear();
    rig.host.setAU(200, 0.4);
    rig.host.bindModel();
    renderHostFrame(rig.host, 0);
    near(rig.host.getAU(200), 0.4, 'rebind retains canonical value');
    near(rig.mesh.morphTargetInfluences[0], 0.4, 'rebound live track uses retained value');
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0, 'old clip base does not leak after rebind');
  } finally { rig.dispose(); }
});

test('completion listeners release a held action before editing its live controls', async () => {
  const rig = await fixture();
  try {
    rig.host.setAU(200, 0.4);
    const name = rig.play([new NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 1], [0.2, 0.8])], 'finish', { loop: false, finalPose: 'hold' });
    const handle = rig.host.playAnimation(name, { loop: false, finalPose: 'hold' });
    let calls = 0;
    handle.subscribe(event => {
      if (event.type !== 'completed') return;
      calls++;
      assert.throws(() => rig.host.setAU(200, 0.6), /driven by animation/);
      rig.host.stopAnimation(name);
      rig.host.setAU(200, 0.6);
    });
    renderHostFrame(rig.host, 2);
    assert.equal(calls, 1);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'listener edits after successful release');
  } finally { rig.dispose(); }
});

test('stop and replay retain the captured base beneath partially weighted native clips', async () => {
  const rig = await fixture(0.2);
  try {
    rig.host.loadAnimationClips([new AnimationClip('replay', 2, [morphTrack(0)])]);
    rig.host.setAU(200, 0.6);
    const handle = rig.host.playAnimation('replay', { loop: true, mixerWeight: 0.5, fadeInSec: 0 });
    renderHostFrame(rig.host, 0.1);
    handle.stop();
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'stopping public clip retains live action');
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.2, 'last release restores authored base');
    handle.play();
    renderHostFrame(rig.host, 0.1);
    near(rig.mesh.morphTargetInfluences[0], 0.5, 'half weight blends against captured base');
    const before = rig.mesh.morphTargetInfluences[0];
    assert.throws(() => rig.host.playClip({ play() { throw new Error('rejected playback'); } }), /rejected playback/);
    near(rig.mesh.morphTargetInfluences[0], before, 'failed play does not mutate existing actions');
  } finally { rig.dispose(); }
});

test('stopAllAnimations releases running and held public clips while preserving live controls', async () => {
  const rig = await fixture();
  try {
    rig.host.registerAnimationClips([
      new AnimationClip('running', 2, [morphTrack(0)]),
      new AnimationClip('held', 0.2, [new NumberKeyframeTrack('Face.morphTargetInfluences[1]', [0, 0.2], [0.7, 0.7])]),
    ]);
    rig.host.setAU(200, 0.4);
    rig.host.setAU(201, 0.3);
    rig.host.playAnimation('running', { loop: true });
    rig.host.playAnimation('held', { loop: false, finalPose: 'hold' });
    renderHostFrame(rig.host, 0.3);
    assert.equal(rig.host.getAnimationState('running').playing, true);
    assert.equal(rig.host.getAnimationState('held').completed, true);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'running clip and live AU both contribute');
    near(rig.mesh.morphTargetInfluences[1], 0.5, 'held clip and independent live AU both contribute');

    rig.host.stopAllAnimations();
    renderHostFrame(rig.host, 0);
    for (const name of ['running', 'held']) {
      assert.equal(rig.host.getAnimationState(name).actionId, undefined, `${name} action is released`);
      assert.equal(rig.host.getAnimationState(name).playing, false);
    }
    near(rig.host.getAU(200), 0.4, 'first canonical live value remains');
    near(rig.host.getAU(201), 0.3, 'independent canonical live value remains');
    near(rig.mesh.morphTargetInfluences[0], 0.4, 'first live track remains rendered');
    near(rig.mesh.morphTargetInfluences[1], 0.3, 'independent live track remains rendered');
    near(rig.mesh.morphTargetInfluences[2], 0.35, 'unmapped morph remains untouched');
  } finally { rig.dispose(); }
});

test('profile replacement clears live state and model replacement keeps each reference with its object', async () => {
  const rig = await fixture(0.15);
  const replacement = makeModel(0.25);
  try {
    rig.host.setAU(200, 0.6);
    renderHostFrame(rig.host, 0);
    const unbound = rig.model.getObjectByName('Unbound');
    unbound.position.x = 9;
    rig.mesh.morphTargetInfluences[2] = 0.9;
    rig.host.bindModel();
    renderHostFrame(rig.host, 0);
    near(unbound.position.x, 9, 'unrelated manual bone pose remains');
    near(rig.mesh.morphTargetInfluences[2], 0.9, 'unmapped manual morph remains');
    rig.host.setProfile({ ...profile, name: 'Edited profile' });
    renderHostFrame(rig.host, 0);
    near(rig.host.getAU(200), 0, 'new profile clears old semantic state');
    near(rig.mesh.morphTargetInfluences[0], 0.15, 'new profile restores reference');
    rig.host.setAU(200, 0.6);
    renderHostFrame(rig.host, 0);
    rig.host.onReady({ model: replacement.model });
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.15, 'old object is released');
    near(replacement.mesh.morphTargetInfluences[0], 0.6, 'live values follow the model binding');
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0);
    near(replacement.mesh.morphTargetInfluences[0], 0.25, 'new object retains its own base');
    rig.dispose();
    near(replacement.mesh.morphTargetInfluences[0], 0.25, 'dispose releases current model');
  } finally { rig.dispose(); replacement.mesh.geometry.dispose(); replacement.mesh.material.dispose(); }
});

test('registering optional clips leaves paused native actions and live contributions intact', async () => {
  const rig = await fixture(0.15);
  try {
    rig.host.setAU(200, 0.4);
    const name = rig.play([morphTrack(0)]);
    renderHostFrame(rig.host, 0.4);
    rig.host.pauseAnimation(name);
    const time = rig.host.getAnimationState(name).time;
    assert.throws(() => rig.host.setAU(200, 0.4), /driven by animation/);
    renderHostFrame(rig.host, 0);
    rig.host.registerAnimationClips([
      new AnimationClip('optional', 2, [morphTrack(1, [0.2, 0.2])]),
      new AnimationClip(name, 2, [morphTrack(0, [0.6, 0.6])]),
    ]);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'native blend remains');
    near(rig.host.getAnimationState(name).time, time, 'registration does not advance paused action');
    assert.throws(() => rig.host.setAU(200, 0), /driven by animation/);
    renderHostFrame(rig.host, 0.1);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'registration does not replace the existing paused action');
    rig.host.stopAllAnimations();
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.15, 'releasing the last action restores the captured reference');
    rig.host.playAnimation(name, { loop: true, fadeInSec: 0 });
    renderHostFrame(rig.host, 0.1);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'the next playback uses the replacement source');
  } finally { rig.dispose(); }
});

test('availability subscriptions report exact action IDs, aliases, release and stale bindings', async () => {
  const rig = await fixture();
  const snapshots = [];
  const unsubscribe = rig.host.subscribeLiveControlAvailability(snapshot => snapshots.push(snapshot));
  try {
    assert.equal(snapshots[0].available, true);
    rig.play([morphTrack(0)], 'first');
    rig.play([morphTrack(0)], 'second');
    const availability = rig.host.getLiveControlAvailability({ kind: 'au', id: 202 });
    assert.equal(availability.blockers.length, 2, 'different AU IDs sharing one morph share its locks');
    assert.deepEqual(availability.blockers.map(item => item.actionId).sort(),
      ['first', 'second'].map(name => rig.host.getAnimationState(name).actionId).sort());
    assert.equal(rig.host.getLiveControlAvailability({ kind: 'au', id: 201 }).available, true);
    assert.throws(() => rig.host.playAnimation('first', { easing: 'invalid' }), /Unknown playback easing/);
    assert.equal(rig.host.getLiveControlAvailability({ kind: 'morph', key: 'A' }).blockers.length, 2,
      'failed replacement retains both predecessor locks');
    rig.host.stopAnimation('first');
    assert.equal(rig.host.getLiveControlAvailability({ kind: 'au', id: 200 }).blockers.length, 1);
    const old = rig.host.buildPoseClip('obsolete', { aus: { 200: 0.4 } });
    const generation = snapshots.at(-1).bindingGeneration;
    rig.host.bindModel();
    assert.equal(snapshots.at(-1).available, true);
    assert.ok(snapshots.at(-1).bindingGeneration > generation);
    assert.throws(() => old.play(), /obsolete model binding/);
    unsubscribe(); unsubscribe();
    const count = snapshots.length;
    rig.play([morphTrack(0)], 'after-unsubscribe');
    assert.equal(snapshots.length, count);
  } finally { unsubscribe(); rig.dispose(); }
});

test('crossfade outgoing targets remain locked until their native fade releases', async () => {
  const rig = await fixture();
  try {
    rig.play([morphTrack(0)], 'outgoing');
    rig.host.registerAnimationClips([new AnimationClip('incoming', 2, [morphTrack(1)])]);
    rig.host.crossfadeTo('incoming', 0.5, { loop: true });
    renderHostFrame(rig.host, 0.25);
    assert.equal(rig.host.getLiveControlAvailability({ kind: 'au', id: 200 }).available, false);
    assert.throws(() => rig.host.transitionMorph('A', 0.2), /driven by animation/);
    renderHostFrame(rig.host, 0.3);
    assert.equal(rig.host.getLiveControlAvailability({ kind: 'au', id: 200 }).available, true);
    assert.equal(rig.host.getLiveControlAvailability({ kind: 'au', id: 201 }).available, false);
  } finally { rig.dispose(); }
});

test('normal saved pose preview replaces its live baseline and restores it on release', async () => {
  const rig = await fixture();
  try {
    rig.host.setAU(200, 0.2);
    const preview = rig.host.playPose('preview', { aus: { 200: 0.8 } }, { blendMode: 'replace', finalPose: 'hold' });
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.8, 'pose is absolute, without live baseline doubling');
    rig.host.setAU(201, 0.4);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.8, 'unrelated live edit does not resurrect the baseline');
    preview.stop();
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.2, 'preview release reveals previous live pose');
    near(rig.mesh.morphTargetInfluences[1], 0.4, 'independent live edit survives');
  } finally { rig.dispose(); }
});

test('exact AU-only pose transfer keeps displayed output and unrelated live transition clocks', async () => {
  const rig = await fixture();
  try {
    rig.host.setAU(200, 0.2);
    rig.host.transitionAU(201, 1, 1000);
    renderHostFrame(rig.host, 0.25);
    near(rig.mesh.morphTargetInfluences[1], 0.25, 'unrelated transition is in flight');
    rig.host.playPose('apply', { aus: { 200: 0.7 } }, { blendMode: 'replace', finalPose: 'hold' });
    renderHostFrame(rig.host, 0);
    assert.equal(rig.host.getLiveControlAvailability({ kind: 'au', id: 200 }).blockers[0].keepPoseSupported, true);
    assert.deepEqual(rig.host.stopAnimationKeepPose('apply'), { accepted: true });
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.7, 'transfer preserves pose');
    near(rig.mesh.morphTargetInfluences[1], 0.25, 'transfer does not complete an unrelated transition');
    renderHostFrame(rig.host, 0.25);
    near(rig.mesh.morphTargetInfluences[1], 0.5, 'unrelated clock continues');
    rig.host.setAU(200, 0.5);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.5, 'transferred control becomes editable');
  } finally { rig.dispose(); }
});

test('mixed saved AU and raw bone pose preserves outputs and refuses unsupported transfer unchanged', async () => {
  const rig = await fixture();
  try {
    const pose = { aus: { 200: 0.6 }, bones: { extra: {
      rawName: 'Unbound', rotation: [0, 0, 0, 1], position: [1, 2, 3], scale: [1, 2, 1],
    } } };
    const prepared = rig.host.buildPoseClip('mixed-pose', pose, { finalPose: 'hold' });
    assert.equal(rig.host.getLiveControlAvailability().available, true, 'preparation owns no targets');
    prepared.play();
    renderHostFrame(rig.host, 0);
    const extra = rig.model.getObjectByName('Unbound');
    assert.deepEqual(extra.position.toArray(), [1, 2, 3]);
    assert.deepEqual(extra.scale.toArray(), [1, 2, 1]);
    assert.equal(rig.host.getLiveControlAvailability({ kind: 'bone', name: 'Unbound', property: 'scale' }).available, false);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'mapped morph survives raw pose compilation');
    const id = rig.host.getAnimationState('mixed-pose').actionId;
    assert.equal(rig.host.stopAnimationKeepPose('mixed-pose').accepted, false);
    assert.equal(rig.host.getAnimationState('mixed-pose').actionId, id, 'unsupported transfer retains action');
    assert.equal(rig.host.getAU(200), 0, 'unsupported transfer retains canonical live state');
    assert.throws(() => rig.host.buildPoseClip('invalid-pose', { bones: { missing: { position: [1, 2, 3] } } }), /does not resolve/);
    assert.equal(rig.host.getAnimationState('mixed-pose').actionId, id);
  } finally { rig.dispose(); }
});

test('additive AU transfer preserves both mapped bone and morph outputs', async () => {
  const rig = await fixture();
  try {
    rig.host.playSnippet('additive', {
      200: [{ time: 0, intensity: 0.5 }, { time: 1, intensity: 0.5 }],
      210: [{ time: 0, intensity: 0.6 }, { time: 1, intensity: 0.6 }],
    }, { blendMode: 'additive', finalPose: 'hold' });
    renderHostFrame(rig.host, 0.25);
    const before = rig.bone.quaternion.clone();
    assert.equal(rig.host.stopAnimationKeepPose('additive').accepted, true);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.5, 'mapped morph is retained');
    near(before.normalize().angleTo(rig.bone.quaternion.clone().normalize()), 0, 'mapped bone is retained');
    assert.equal(rig.host.getLiveControlAvailability().available, true);
  } finally { rig.dispose(); }
});
