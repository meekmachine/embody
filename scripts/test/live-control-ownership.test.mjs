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

test('a live track and a changing clip share their target through native normal blending', async () => {
  const rig = await fixture();
  try {
    rig.play([morphTrack(0, [0.2, 1])]);
    renderHostFrame(rig.host, 0.25);
    rig.host.setAU(200, 0.9);
    renderHostFrame(rig.host, 0.25);
    near(rig.mesh.morphTargetInfluences[0], (0.4 + 0.9) / 2, 'equal native weights mix both clips');
    renderHostFrame(rig.host, 0.5);
    near(rig.mesh.morphTargetInfluences[0], (0.6 + 0.9) / 2, 'underlying clip continues advancing');
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'release reveals current clip sample');
  } finally { rig.dispose(); }
});

for (const pause of ['none', 'action', 'mixer', 'finished-held']) {
  test(`releasing a live track reveals the clip with ${pause} paused`, async () => {
    const rig = await fixture();
    try {
      const name = rig.play([morphTrack(0)], 'underlying', { loop: pause !== 'finished-held', finalPose: 'hold' });
      renderHostFrame(rig.host, 0.1);
      rig.host.setAU(200, 0.4);
      renderHostFrame(rig.host, 0.1);
      near(rig.mesh.morphTargetInfluences[0], 0.6, 'both actions contribute');
      if (pause === 'action') rig.host.pauseAnimation(name);
      if (pause === 'mixer') rig.host.setAnimationTimeScale(0);
      if (pause === 'finished-held') renderHostFrame(rig.host, 2);
      rig.host.setAU(200, 0);
      renderHostFrame(rig.host, 0);
      near(rig.mesh.morphTargetInfluences[0], 0.8, 'release exposes native held or paused sample');
    } finally { rig.dispose(); }
  });
}

test('Rust aggregates semantic targets before their live track participates in native blending', async () => {
  const rig = await fixture();
  try {
    rig.play([morphTrack(0)]);
    rig.host.setAU(200, 0.3);
    rig.host.setAU(202, 0.6);
    renderHostFrame(rig.host, 0.1);
    near(rig.mesh.morphTargetInfluences[0], 0.7, 'Rust max AU value 0.6 mixes with native 0.8');
    rig.host.setAU(202, 0);
    rig.host.setViseme(0, 0.5);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.65, 'Rust resolves viseme and AU before native mixing');
    rig.host.setMorph('A', 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.4, 'explicit direct zero stays a native contribution');
    near(rig.host.getAU(200), 0.3, 'direct morph leaves canonical AU state intact');
    rig.host.releaseMorph('A');
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.65, 'releasing direct target reveals semantic contribution');
    rig.host.setViseme(0, 0);
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.8, 'releasing semantic targets leaves the clip');
  } finally { rig.dispose(); }
});

test('bone position and quaternion tracks blend and release independently', async () => {
  const rig = await fixture();
  try {
    const name = rig.play([positionTrack(), rotationTrack()]);
    renderHostFrame(rig.host, 0.1);
    rig.host.setAU(210, 1);
    renderHostFrame(rig.host, 0);
    assertRotation(rig.bone, (0.9 + Math.PI / 6) / 2, 'native quaternion blend');
    rig.bone.position.toArray().forEach((v, i) => near(v, [3, 4, 5][i], 'unrelated position'));
    rig.host.setAU(211, 0.5);
    renderHostFrame(rig.host, 0);
    rig.bone.position.toArray().forEach((v, i) => near(v, [2, 2, 2.5][i], 'native position blend'));
    rig.host.pauseAnimation(name);
    rig.host.setAU(210, 0);
    renderHostFrame(rig.host, 0);
    assertRotation(rig.bone, 0.9, 'rotation releases to paused clip');
    near(rig.bone.position.x, 2, 'translation remains active');
    rig.host.setAU(211, 0);
    renderHostFrame(rig.host, 0);
    rig.bone.position.toArray().forEach((v, i) => near(v, [3, 4, 5][i], 'translation releases'));
  } finally { rig.dispose(); }
});

test('clear releases live tracks while same-model rebind retains canonical controls', async () => {
  const rig = await fixture();
  try {
    rig.play([morphTrack(0), rotationTrack()]);
    rig.host.setAU(200, 0.4);
    rig.host.setAU(210, 1);
    renderHostFrame(rig.host, 0.1);
    rig.host.clear();
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.8, 'clear leaves public clip');
    assertRotation(rig.bone, 0.9, 'clear releases live rotation');
    rig.host.setAU(200, 0.4);
    renderHostFrame(rig.host, 0);
    rig.host.bindModel();
    renderHostFrame(rig.host, 0);
    near(rig.host.getAU(200), 0.4, 'rebind retains canonical value');
    near(rig.mesh.morphTargetInfluences[0], 0.4, 'rebound live track uses retained value');
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0, 'old clip base does not leak after rebind');
  } finally { rig.dispose(); }
});

test('completion listeners can replace live tracks after native mixer sampling', async () => {
  const rig = await fixture();
  try {
    const name = rig.play([new NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 1], [0.2, 0.8])], 'finish', { loop: false, finalPose: 'hold' });
    // The fixture clip has a two-second duration even though its last key is at one second.
    rig.host.setAU(200, 0.4);
    const handle = rig.host.playAnimation(name, { loop: false, finalPose: 'hold' });
    let calls = 0;
    handle.subscribe(event => { if (event.type === 'completed') { calls++; rig.host.setAU(200, 0.6); } });
    renderHostFrame(rig.host, 2);
    assert.equal(calls, 1, 'completion delivered once after the native frame');
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.7, 'listener command participates in the next native sample');
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.8, 'held clip remains');
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
    rig.host.playAnimation('running', { loop: true });
    rig.host.playAnimation('held', { loop: false, finalPose: 'hold' });
    rig.host.setAU(200, 0.4);
    rig.host.setAU(201, 0.3);
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
    const name = rig.play([morphTrack(0)]);
    renderHostFrame(rig.host, 0.4);
    rig.host.pauseAnimation(name);
    const time = rig.host.getAnimationState(name).time;
    rig.host.setAU(200, 0.4);
    renderHostFrame(rig.host, 0);
    rig.host.registerAnimationClips([
      new AnimationClip('optional', 2, [morphTrack(1, [0.2, 0.2])]),
      new AnimationClip(name, 2, [morphTrack(0, [0.6, 0.6])]),
    ]);
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'native blend remains');
    near(rig.host.getAnimationState(name).time, time, 'registration does not advance paused action');
    rig.host.setAU(200, 0);
    renderHostFrame(rig.host, 0.1);
    near(rig.mesh.morphTargetInfluences[0], 0.8, 'registration does not replace the existing paused action');
    rig.host.stopAllAnimations();
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], 0.15, 'releasing the last action restores the captured reference');
    rig.host.playAnimation(name, { loop: true, fadeInSec: 0 });
    renderHostFrame(rig.host, 0.1);
    near(rig.mesh.morphTargetInfluences[0], 0.6, 'the next playback uses the replacement source');
  } finally { rig.dispose(); }
});

for (const mode of ['live', 'compiled']) {
  test(`face edits restrict expression, blink and speech on native ${mode} frames`, async () => {
    const model = new Group();
    const names = ['Skin_1', 'Skin_2', 'Brows', 'Lashes', 'Shirt'];
    const meshes = names.map(name => {
      const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
      mesh.name = name;
      mesh.morphTargetDictionary = { Smile: 0, Blink: 1, Talk: 2, Flex: 3 };
      mesh.morphTargetInfluences = [0, 0, 0, 0];
      model.add(mesh);
      return mesh;
    });
    const channels = [
      { target: { type: 'au', id: 12 } },
      { target: { type: 'au', id: 45 } },
      { target: { type: 'viseme', id: 0 } },
      { target: { type: 'au', id: 1001 } },
    ].map(channel => ({ ...channel, keyframes: [{ time: 0, intensity: 1 }, { time: 1, intensity: 1 }] }));
    const configuration = face => ({
      auToMorphs: { 12: { center: ['Smile'] }, 45: { center: ['Blink'] }, 1001: { center: ['Flex'] } },
      auInfo: { 45: { facePart: 'Eyelids' }, 1001: { facePart: 'Body' } },
      auFacePartToMeshCategory: { Eyelids: 'eye', Body: 'body' },
      // Legacy eye/speech lists must not animate the unselected Shirt.
      morphToMesh: { face, eye: ['Shirt'], viseme: ['Shirt'], body: ['Shirt'] },
      visemeKeys: ['Talk'], visemeMeshCategory: 'viseme', hairPhysics: { enabled: false },
    });
    const host = await createRustEmbodyHost(model, { profileMode: 'profile', profile: configuration(['Skin']) });
    try {
      for (const selection of [['Skin'], ['Skin_2', 'Brows'], ['Lashes'], [], ['Missing'], ['Skin', 'Lashes']]) {
        host.stopAllAnimations();
        host.clear();
        host.setProfile(configuration(selection));
        if (mode === 'live') {
          host.setAU(12, 1); host.setAU(45, 1); host.setViseme(0, 1); host.setAU(1001, 1);
        } else {
          host.buildTypedClip('face-selection', channels, { autoVisemeJaw: false, fadeInSec: 0 }).play();
        }
        renderHostFrame(host, 0.25);
        for (const mesh of meshes) {
          const selected = selection.includes(mesh.name) || (selection.includes('Skin') && mesh.name.startsWith('Skin_'));
          for (const target of ['Smile', 'Blink', 'Talk']) {
            near(mesh.morphTargetInfluences[mesh.morphTargetDictionary[target]], selected ? 1 : 0,
              `${selection}/${mesh.name}/${target}`);
          }
          near(mesh.morphTargetInfluences[3], mesh.name === 'Shirt' ? 1 : 0, 'body route remains independent');
        }
      }
    } finally {
      host.dispose();
      for (const mesh of meshes) { mesh.geometry.dispose(); mesh.material.dispose(); }
    }
  });
}

for (const paused of [false, true]) {
  test(`mapping edits retain live controls and ${paused ? 'paused' : 'playing'} public clip handles`, async () => {
    const rig = await fixture();
    try {
      const prepared = rig.host.buildTypedClip('prepared', [
        { target: { type: 'au', id: 201 }, keyframes: [{ time: 0, intensity: 0.7 }, { time: 2, intensity: 0.7 }] },
      ], { fadeInSec: 0, autoVisemeJaw: false });
      const playing = rig.host.buildTypedClip('editing', [
        { target: { type: 'au', id: 200 }, keyframes: [{ time: 0, intensity: 0.2 }, { time: 2, intensity: 1 }] },
      ], { fadeInSec: 0, autoVisemeJaw: false, loop: true }).play();
      const baked = new AnimationClip('independent-baked', 2, [
        new VectorKeyframeTrack('Unbound.position', [0, 2], [0, 0, 0, 2, 0, 0]),
      ]);
      rig.host.registerAnimationClips([baked]);
      const bakedHandle = rig.host.playAnimation(baked.name, { fadeInSec: 0, loop: true });
      rig.host.setViseme(1, 0.3);
      renderHostFrame(rig.host, 0.5);
      if (paused) { playing.pause(); bakedHandle.pause(); }
      const finished = playing.finished;
      const events = [];
      playing.subscribe(event => events.push(event));
      for (const face of [[], ['Face'], [], ['Face']]) {
        rig.host.setProfile({ ...profile, morphToMesh: { face } }, { preservePlayback: true });
        assert.equal(playing.finished, finished, 'remapping retains the pending completion promise');
        assert.deepEqual(events, [], 'editing does not report playback cancellation');
        near(rig.host.getViseme(1), 0.3, 'canonical live control remains accepted');
        renderHostFrame(rig.host, 0);
        near(rig.mesh.morphTargetInfluences[0], face.length ? 0.4 : 0, 'clip retains its local time and follows selection');
        near(rig.mesh.morphTargetInfluences[1], face.length ? 0.3 : 0, 'live control follows selection');
        near(rig.model.getObjectByName('Unbound').position.x, 0.5, 'baked playback retains its time');
        assert.doesNotThrow(() => playing.setSpeed(1));
        assert.doesNotThrow(() => bakedHandle.setSpeed(1));
      }
      renderHostFrame(rig.host, 0.25);
      near(rig.mesh.morphTargetInfluences[0], paused ? 0.4 : 0.5, 'paused state survives editing');
      assert.doesNotThrow(() => playing.seek(1).setWeight(0.5).pause().resume());
      assert.doesNotThrow(() => prepared.play().stop(), 'prepared handles remain playable after edits');
      playing.stop();
      assert.equal((await finished).type, 'cancelled');
    } finally { rig.dispose(); }
  });
}

for (const loopMode of ['repeat', 'pingpong']) {
  test(`profile edits retain ${loopMode} progress and the remaining finite loop count`, async () => {
    const edited = await fixture();
    const control = await fixture();
    const makeClip = () => new AnimationClip('loops', 1, [
      new VectorKeyframeTrack('Unbound.position', [0, 1], [0, 0, 0, 1, 0, 0]),
    ]);
    try {
      for (const rig of [edited, control]) {
        rig.host.registerAnimationClips([makeClip()]);
        rig.host.playAnimation('loops', { loopMode, repeatCount: 3, finalPose: 'release', fadeInSec: 0 });
        renderHostFrame(rig.host, 1.25);
      }
      edited.host.setProfile(profile, { preservePlayback: true });
      for (const delta of [0, 0.25, 0.75, 1, 0.1]) {
        for (const rig of [edited, control]) renderHostFrame(rig.host, delta);
        near(edited.model.getObjectByName('Unbound').position.x,
          control.model.getObjectByName('Unbound').position.x, 'profile edit retains native loop direction and completion');
        assert.equal(edited.host.getAnimationState('loops').playing, control.host.getAnimationState('loops').playing);
      }
    } finally { edited.dispose(); control.dispose(); }
  });
}

for (const fade of ['in', 'out']) {
  test(`profile edits retain an active fade ${fade}`, async () => {
    const edited = await fixture();
    const control = await fixture();
    try {
      for (const rig of [edited, control]) {
        rig.host.registerAnimationClips([new AnimationClip('fading', 4, [
          new VectorKeyframeTrack('Unbound.position', [0, 4], [1, 0, 0, 1, 0, 0]),
        ])]);
        const handle = rig.host.playAnimation('fading', { fadeInSec: fade === 'in' ? 1 : 0, fadeOutSec: 1 });
        if (fade === 'out') handle.stop();
        renderHostFrame(rig.host, 0.25);
      }
      edited.host.setProfile(profile, { preservePlayback: true });
      for (const delta of [0, 0.25, 0.25, 0.3]) {
        for (const rig of [edited, control]) renderHostFrame(rig.host, delta);
        near(edited.model.getObjectByName('Unbound').position.x,
          control.model.getObjectByName('Unbound').position.x, 'editing preserves the current fade and its endpoint');
      }
    } finally { edited.dispose(); control.dispose(); }
  });
}

test('profile edits keep the inherited start captured before other controls changed', async () => {
  const rig = await fixture(0.2);
  try {
    const clip = rig.host.buildTypedClip('inherited', [{
      target: { type: 'au', id: 200 },
      keyframes: [{ time: 0, intensity: 0, inherit: true }, { time: 2, intensity: 1 }],
    }], { autoVisemeJaw: false, fadeInSec: 0 }).play();
    renderHostFrame(rig.host, 0.5);
    const before = rig.mesh.morphTargetInfluences[0];
    rig.host.setProfile(profile, { preservePlayback: true });
    renderHostFrame(rig.host, 0);
    near(rig.mesh.morphTargetInfluences[0], before, 'edit does not recapture the reference or the current mixed pose');
    clip.stop();
  } finally { rig.dispose(); }
});
