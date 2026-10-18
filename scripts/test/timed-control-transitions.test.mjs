import { renderHostFrame } from './helpers/render-playback.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnimationClip, Bone, BufferGeometry, Group, Mesh, MeshBasicMaterial, NumberKeyframeTrack,
  Quaternion, Vector3,
} from 'three';
import { createRustEmbodyHost } from '@lovelace_lol/embody/three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

await initEmbodyCore();

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-5,
  `${message}: expected ${expected}, received ${actual}`);
const nearRotation = (actual, expected, message) => {
  near(actual.lengthSq(), 1, `${message}: actual quaternion length squared`);
  near(expected.lengthSq(), 1, `${message}: expected quaternion length squared`);
  // Native tracks store Float32 samples; angleTo assumes exact unit length.
  near(actual.clone().normalize().angleTo(expected.clone().normalize()), 0, message);
};
const profile = {
  auToMorphs: {
    43: { center: [], left: ['Left'], right: ['Right'] },
    200: { center: ['A'], left: [], right: [] },
    201: { center: ['B'], left: [], right: [] },
    210: { center: ['A'], left: [], right: [] },
  },
  morphToMesh: { face: ['Face'] },
  visemeKeys: ['A', 'B'],
  boneNodes: { HEAD: 'Head' },
  auToBones: { 210: [{ node: 'HEAD', channel: 'rz', scale: 1, maxDegrees: 30 }] },
  compositeRotations: [{ node: 'HEAD', pitch: { aus: [210], axis: 'rz' }, yaw: null, roll: null }],
  hairPhysics: { enabled: false },
};

function makeModel(base = 0) {
  const model = new Group();
  const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.name = 'Face';
  mesh.morphTargetDictionary = { A: 0, B: 1, Unmapped: 2, Left: 3, Right: 4 };
  mesh.morphTargetInfluences = [base, 0, 0.35, 0, 0];
  const bone = new Bone();
  bone.name = 'Head';
  model.add(mesh, bone);
  return { model, mesh, bone };
}

async function fixture() {
  const { model, mesh, bone } = makeModel();
  const host = await createRustEmbodyHost(model, { profileMode: 'profile', profile: structuredClone(profile) });
  let disposed = false;
  return {
    host, model, mesh, bone,
    value(index = 0) { return mesh.morphTargetInfluences[index]; },
    play(index, values = [0.2, 1], duration = 2, loop = true) {
      const name = `underlying-${index}`;
      host.loadAnimationClips([new AnimationClip(name, duration, [
        new NumberKeyframeTrack(`Face.morphTargetInfluences[${index}]`, [0, duration], values),
      ])]);
      return host.playAnimation(name, { loop, finalPose: 'hold', fadeInSec: 0, fadeOutSec: 0 });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      host.dispose();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}

async function bodyFixture() {
  const model = new Group();
  const left = new Bone(); left.name = 'CC_Base_L_Forearm';
  const right = new Bone(); right.name = 'CC_Base_R_Forearm';
  const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.name = 'CC_Base_Body';
  mesh.morphTargetDictionary = {
    LL_Body_Bicep_Flex_L: 0, LL_Body_Bicep_Flex_R: 1, Mouth_Smile_L: 2, Mouth_Smile_R: 3,
  };
  mesh.morphTargetInfluences = [0, 0, 0, 0];
  model.add(left, right, mesh);
  const host = await createRustEmbodyHost(model, { presetId: 'cc4' });
  return {
    host, mesh, left, right,
    dispose() { host.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); },
  };
}

// Observe settlement through microtasks, without wall-clock waits or hanging a
// test on a broken handle. The render fixture advances the real Three Timer and native mixer.
function observe(handle) {
  assert.ok(handle?.promise instanceof Promise, 'transition exposes a completion promise');
  for (const name of ['pause', 'resume', 'cancel']) assert.equal(typeof handle[name], 'function');
  const state = { settled: false };
  handle.promise.then(() => { state.settled = true; });
  return state;
}
async function settled(state, expected, message) {
  // Grouped native actions settle through promise continuations, not a timer.
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  assert.equal(state.settled, expected, message);
}

test('200 ms AU transition keeps canonical target state while Three samples linear tracks', async () => {
  const rig = await fixture();
  try {
    const handle = rig.host.transitionAU(200, 1, 200);
    const done = observe(handle);
    near(rig.host.getAU(200), 1, 'AU getter exposes the accepted target immediately');
    near(rig.value(), 0, 'starting a transition retains its visible source');
    await settled(done, false, 'positive-duration transition is not completed immediately');
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), 0.25, 'quarter duration uses native linear interpolation');
    near(rig.host.getAU(200), 1, 'sampling does not replace canonical target with displayed value');
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), 0.5, 'half duration');
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), 0.75, 'three-quarter duration');
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), 1, 'exact endpoint');
    await settled(done, true, 'endpoint resolves handle');
    renderHostFrame(rig.host, 0.3);
    near(rig.value(), 1, 'canonical target remains after transition cleanup');
  } finally { rig.dispose(); }
});

test('80 ms viseme transition exposes the accepted target while its native track progresses', async () => {
  const rig = await fixture();
  try {
    const done = observe(rig.host.transitionViseme(0, 1, 80, 0.4));
    near(rig.host.getViseme(0), 1, 'viseme getter exposes the accepted target immediately');
    near(rig.host.getVisemeJawScale(0), 0.4, 'jaw scale is accepted at the command boundary');
    renderHostFrame(rig.host, 0.02);
    near(rig.value(), 0.25, 'quarter-duration visible viseme');
    near(rig.host.getViseme(0), 1, 'canonical state is independent of the rendered sample');
    renderHostFrame(rig.host, 0.02);
    near(rig.value(), 0.5, 'half-duration visible viseme');
    near(rig.host.getViseme(0), 1, 'accepted target remains unchanged');
    renderHostFrame(rig.host, 0.04);
    near(rig.value(), 1, 'viseme endpoint');
    near(rig.host.getViseme(0), 1, 'canonical endpoint');
    await settled(done, true, 'viseme handle resolves');
  } finally { rig.dispose(); }
});

test('independent AU transitions keep their own native timing and completion', async () => {
  const rig = await fixture();
  try {
    const first = observe(rig.host.transitionAU(200, 1, 1000));
    renderHostFrame(rig.host, 0.25);
    near(rig.value(), 0.25, 'first transition reaches its quarter sample');
    const second = observe(rig.host.transitionAU(201, 1, 1000));
    await settled(first, false, 'unrelated command does not settle the first handle');
    renderHostFrame(rig.host, 0.25);
    near(rig.value(), 0.5, 'first transition continues on its original timeline');
    near(rig.value(1), 0.25, 'second transition has its own timeline');
    renderHostFrame(rig.host, 0.5);
    near(rig.value(), 1, 'first transition keeps its original endpoint');
    near(rig.value(1), 0.75, 'second remains in progress');
    await settled(first, true, 'first completes independently');
    await settled(second, false, 'second remains pending');
    renderHostFrame(rig.host, 0.25);
    near(rig.value(1), 1, 'second reaches its own endpoint');
    await settled(second, true, 'second completes independently');
  } finally { rig.dispose(); }
});

test('viseme release fades its native contribution toward the captured rest pose', async () => {
  const rig = await fixture();
  try {
    rig.host.setViseme(0, 1);
    renderHostFrame(rig.host, 0);
    const done = observe(rig.host.transitionViseme(0, 0, 80));
    renderHostFrame(rig.host, 0.04);
    near(rig.host.getViseme(0), 0, 'release accepts its canonical target immediately');
    near(rig.value(), 0.5, 'half native weight mixes the held contribution with rest');
    renderHostFrame(rig.host, 0.04);
    near(rig.host.getViseme(0), 0, 'canonical viseme releases at completion');
    near(rig.value(), 0, 'visible release endpoint');
    await settled(done, true, 'viseme release resolves');
  } finally { rig.dispose(); }
});

test('viseme release fades native weight while the underlying clip keeps advancing', async () => {
  const rig = await fixture();
  try {
    rig.play(0);
    renderHostFrame(rig.host, 0.25);
    rig.host.setViseme(0, 1);
    renderHostFrame(rig.host, 0);
    near(rig.value(), 0.65, 'live and public actions use equal native weights');
    const done = observe(rig.host.transitionViseme(0, 0, 80));
    renderHostFrame(rig.host, 0.04);
    near(rig.host.getViseme(0), 0, 'release is canonical before interpolation');
    near(rig.value(), (0.316 + 0.5) / 1.5, 'half release weight mixes with the current public sample');
    renderHostFrame(rig.host, 0.04);
    near(rig.value(), 0.332, 'completion reveals current clip without a jump');
    await settled(done, true, 'moving-base viseme release resolves');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 0.372, 'underlying clip continues after the viseme releases');
  } finally { rig.dispose(); }
});

// Legacy behavior pending the separate morph-only viseme / bone-only jaw AU change.
test('legacy viseme jaw coupling keeps independent morph timing and grouped completion', async () => {
  const model = new Group();
  const jaw = new Bone(); jaw.name = 'Jaw';
  const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.name = 'Face';
  mesh.morphTargetDictionary = { A: 0, B: 1 };
  mesh.morphTargetInfluences = [0, 0];
  model.add(mesh, jaw);
  const host = await createRustEmbodyHost(model, { profileMode: 'profile', profile: {
    morphToMesh: { face: ['Face'] }, visemeKeys: ['A', 'B'], visemeJawAmounts: [1, 1],
    boneNodes: { JAW: 'Jaw' }, auToBones: { 26: [{ node: 'JAW', channel: 'rx', scale: 1, maxDegrees: 30 }] },
    hairPhysics: { enabled: false },
  } });
  try {
    const first = observe(host.transitionViseme(0, 1, 1000));
    renderHostFrame(host, 0.25);
    near(host.getViseme(0), 1, 'first viseme target is canonical');
    near(mesh.morphTargetInfluences[0], 0.25, 'first independent morph begins normally');
    assert.ok(jaw.quaternion.x > 0, 'fixture actually drives a shared jaw bone');
    const second = observe(host.transitionViseme(1, 1, 1000));
    await settled(first, false, 'sharing a jaw does not complete the first logical transition');
    renderHostFrame(host, 0.25);
    near(host.getViseme(0), 1, 'first target survives shared-property handoff');
    near(host.getViseme(1), 1, 'second target is accepted independently');
    near(mesh.morphTargetInfluences[0], 0.5, 'first independent morph continues');
    near(mesh.morphTargetInfluences[1], 0.25, 'second independent morph progresses');
    renderHostFrame(host, 0.5);
    near(host.getViseme(0), 1, 'first reaches its original endpoint');
    near(host.getViseme(1), 1, 'second target remains canonical while its track runs');
    near(mesh.morphTargetInfluences[0], 1, 'first morph reaches target');
    near(mesh.morphTargetInfluences[1], 0.75, 'second morph retains its own elapsed time');
    await settled(first, true, 'first handle completes after its own second');
    await settled(second, false, 'second handle remains pending');
    renderHostFrame(host, 0.25);
    near(host.getViseme(1), 1, 'second reaches its later endpoint');
    near(mesh.morphTargetInfluences[1], 1, 'second morph reaches target');
    await settled(second, true, 'second handle completes on its own clock');
  } finally { host.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); }
});

test('an unknown viseme slot returns a settled no-op handle', async () => {
  const rig = await fixture();
  try {
    rig.host.setAU(200, 0.4);
    renderHostFrame(rig.host, 0);
    const before = [...rig.mesh.morphTargetInfluences];
    const done = observe(rig.host.transitionVisemeById('missing-viseme-slot', 1, 80));
    await settled(done, true, 'missing slot resolves without starting an animation');
    renderHostFrame(rig.host, 0.1);
    assert.deepEqual(rig.mesh.morphTargetInfluences, before, 'missing slot leaves all pose channels intact');
  } finally { rig.dispose(); }
});

test('timed AU controls retain bilateral ownership and interpolate bone quaternions', async () => {
  const rig = await fixture();
  try {
    rig.host.transitionAU(210, 1, 200);
    rig.host.transitionAU(43, 0.8, 200, -1);
    renderHostFrame(rig.host, 0.05);
    const expected = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (30 * Math.PI / 180) * 0.25);
    nearRotation(rig.bone.quaternion, expected, 'bone uses native quaternion interpolation');
    near(rig.value(3), 0.2, 'left quarter-duration intensity');
    near(rig.value(4), 0, 'right side stays neutral');
    renderHostFrame(rig.host, 0.05);
    near(rig.value(3), 0.4, 'left midpoint');
    rig.host.transitionAU(43, 0.6, 200, 1);
    near(rig.host.getAUBalance(43), 1, 'replacement updates canonical balance immediately');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(3), 0.2, 'left side fades out from its visible value');
    near(rig.value(4), 0.3, 'right side fades in independently');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(3), 0, 'old side is released at completion');
    near(rig.value(4), 0.6, 'new side reaches target');
  } finally { rig.dispose(); }
});

test('120 ms direct morph transition samples the current rendered value and keeps an explicit zero override', async () => {
  const rig = await fixture();
  try {
    const done = observe(rig.host.transitionMorph('A', 1, 120));
    near(rig.value(), 0, 'direct morph does not jump at start');
    renderHostFrame(rig.host, 0.03);
    near(rig.value(), 0.25, 'direct morph quarter duration');
    renderHostFrame(rig.host, 0.03);
    near(rig.value(), 0.5, 'direct morph half duration');
    renderHostFrame(rig.host, 0.06);
    near(rig.value(), 1, 'direct morph endpoint');
    await settled(done, true, 'morph handle resolves');
    rig.play(0, [0.7, 0.7]);
    const zero = observe(rig.host.transitionMorph('A', 0, 120));
    renderHostFrame(rig.host, 0.12);
    await settled(zero, true, 'zero morph handle resolves');
    near(rig.value(), 0.35, 'explicit zero still contributes equal native weight beside the public clip');
    rig.host.releaseMorph('A');
    renderHostFrame(rig.host, 0);
    near(rig.value(), 0.7, 'explicit release returns the clip');
  } finally { rig.dispose(); }
});

for (const kind of ['AU', 'viseme', 'morph']) {
  test(`zero-duration ${kind} transition is sampled and settled by native rendering`, async () => {
    const rig = await fixture();
    try {
      const handle = kind === 'AU' ? rig.host.transitionAU(200, 0.8, 0)
        : kind === 'viseme' ? rig.host.transitionViseme(0, 0.8, 0)
          : rig.host.transitionMorph('A', 0.8, 0);
      const done = observe(handle);
      near(rig.value(), 0, 'command does not sample the renderer');
      renderHostFrame(rig.host, 0);
      near(rig.value(), 0.8, 'zero duration has its target on the first native sample');
      renderHostFrame(rig.host, 0.001);
      await settled(done, true, 'zero duration resolves');
      handle.pause(); handle.resume(); handle.cancel();
      renderHostFrame(rig.host, 0.25);
      near(rig.value(), 0.8, 'settled handle operations are harmless');
    } finally { rig.dispose(); }
  });
}

test('pause and resume preserve elapsed transition time without pausing an unrelated clip', async () => {
  const rig = await fixture();
  try {
    rig.play(1);
    const handle = rig.host.transitionAU(200, 1, 200);
    const done = observe(handle);
    renderHostFrame(rig.host, 0.05);
    handle.pause();
    renderHostFrame(rig.host, 0.5);
    near(rig.value(), 0.25, 'paused transition stays on its sampled pose');
    near(rig.value(1), 0.42, 'unrelated clip advances during pause');
    await settled(done, false, 'paused handle remains pending');
    handle.resume();
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), 0.5, 'resumed transition continues its own elapsed time');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 1, 'resumed endpoint');
    await settled(done, true, 'resumed handle completes');
  } finally { rig.dispose(); }
});

test('cancel releases the native action while preserving the accepted semantic target', async () => {
  const rig = await fixture();
  try {
    const handle = rig.host.transitionAU(200, 1, 200);
    const done = observe(handle);
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), 0.25, 'transition reached its quarter sample');
    handle.cancel();
    renderHostFrame(rig.host, 0);
    await settled(done, true, 'cancel settles handle');
    near(rig.value(), 0, 'cancel releases the contribution to its captured base');
    near(rig.host.getAU(200), 1, 'cancel preserves the accepted semantic target');
    handle.resume();
    renderHostFrame(rig.host, 0.5);
    near(rig.value(), 0, 'cancelled handle cannot restart');
    rig.host.setAU(200, 0.7);
    renderHostFrame(rig.host, 0);
    near(rig.value(), 0.7, 'new AU command creates its own native contribution');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 0.7, 'retired transition stays retired');
  } finally { rig.dispose(); }
});

test('replacement starts from the current visible pose and settles the replaced handle', async () => {
  const rig = await fixture();
  try {
    const first = observe(rig.host.transitionAU(200, 1, 200));
    renderHostFrame(rig.host, 0.05);
    const second = observe(rig.host.transitionAU(200, 0.6, 200));
    await settled(first, true, 'replacement settles prior handle');
    renderHostFrame(rig.host, 0);
    near(rig.value(), 0.25, 'replacement retains the visible start');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 0.425, 'replacement midpoint interpolates linearly from current pose');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 0.6, 'replacement reaches its own target');
    await settled(second, true, 'replacement completes');
  } finally { rig.dispose(); }
});

test('a numeric morph setter reclaims a canceled named action even with an unchanged canonical target', async () => {
  const rig = await fixture();
  try {
    rig.host.setAU(201, 0.4);
    const handle = rig.host.transitionMorph('A', 1, 200);
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 0.5, 'named morph reaches its midpoint');
    handle.cancel();
    renderHostFrame(rig.host, 0);
    near(rig.value(), 0, 'cancel releases the named morph');
    rig.host.setMorph(0, 1);
    renderHostFrame(rig.host, 0);
    near(rig.value(), 1, 'numeric alias reclaims the same concrete morph');
    near(rig.value(1), 0.4, 'unrelated AU output is preserved immediately');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 1, 'canceled named action cannot overwrite numeric setter');
    near(rig.value(1), 0.4, 'unrelated AU remains authoritative');
    near(rig.value(2), 0.35, 'unmapped morph is untouched');
  } finally { rig.dispose(); }
});

test('a numeric morph transition reclaims a canceled named target from its released base', async () => {
  const rig = await fixture();
  try {
    rig.host.setAU(201, 0.4);
    const previous = rig.host.transitionMorph('A', 1, 200);
    renderHostFrame(rig.host, 0.1);
    previous.cancel();
    renderHostFrame(rig.host, 0);
    const done = observe(rig.host.transitionMorph(0, 1, 200));
    near(rig.value(), 0, 'alias replacement starts from the released visible pose');
    await settled(done, false, 'alias replacement still has a visible transition to perform');
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), 0.25, 'numeric alias interpolates from its released base');
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), 0.5, 'numeric replacement midpoint');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 1, 'numeric replacement reaches target');
    await settled(done, true, 'numeric replacement resolves');
    near(rig.value(1), 0.4, 'unrelated AU is preserved');
    near(rig.value(2), 0.35, 'unmapped morph is untouched');
  } finally { rig.dispose(); }
});

test('timed AU writes preserve unrelated constant mixer channels and unmapped morphs', async () => {
  const rig = await fixture();
  try {
    rig.play(1, [0.8, 0.8]);
    renderHostFrame(rig.host, 0.1);
    rig.host.transitionAU(200, 1, 200);
    for (let tick = 0; tick < 6; tick++) {
      renderHostFrame(rig.host, 0.05);
      near(rig.value(1), 0.8, 'constant cached mixer property is preserved');
      near(rig.value(2), 0.35, 'unmapped property is preserved');
    }
  } finally { rig.dispose(); }
});

test('AU release fades native weight toward the changing underlying clip without an endpoint jump', async () => {
  const rig = await fixture();
  try {
    rig.play(0);
    renderHostFrame(rig.host, 0.25);
    rig.host.setAU(200, 0.9);
    renderHostFrame(rig.host, 0);
    const done = observe(rig.host.transitionAU(200, 0, 200));
    near(rig.host.getAU(200), 0, 'canonical AU releases at command time');
    near(rig.value(), 0.6, 'release keeps the equal-weight native mixed pose');
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), (0.32 + 0.9 * 0.75) / 1.75, 'quarter release uses native weight 0.75');
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), (0.34 + 0.9 * 0.5) / 1.5, 'midpoint uses native weight 0.5');
    renderHostFrame(rig.host, 0.099);
    near(rig.value(), (0.3796 + 0.9 * 0.005) / 1.005, 'sample just before completion approaches current clip');
    renderHostFrame(rig.host, 0.001);
    near(rig.value(), 0.38, 'completion exposes the current sample continuously');
    await settled(done, true, 'release completes');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 0.42, 'clip continues after release');
  } finally { rig.dispose(); }
});

test('pausing a release preserves its native fade weight while the public clip advances', async () => {
  const rig = await fixture();
  try {
    rig.play(0);
    renderHostFrame(rig.host, 0.25);
    rig.host.setAU(200, 0.9);
    renderHostFrame(rig.host, 0);
    const handle = rig.host.transitionAU(200, 0, 200);
    const done = observe(handle);
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), (0.32 + 0.9 * 0.75) / 1.75, 'release has consumed one quarter of its fade');
    handle.pause();
    renderHostFrame(rig.host, 0.5);
    near(rig.value(), (0.52 + 0.9 * 0.75) / 1.75, 'paused contribution keeps its weight beside the advancing clip');
    await settled(done, false, 'paused release remains pending');
    handle.resume();
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), (0.54 + 0.9 * 0.5) / 1.5, 'resume consumes the next quarter of the original fade');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 0.58, 'completed release exposes the current public sample');
    await settled(done, true, 'resumed release completes');
  } finally { rig.dispose(); }
});

test('a later mix-weight command reclaims a canceled mixed AU target', async () => {
  const rig = await fixture();
  try {
    const handle = rig.host.transitionAU(210, 1, 200);
    renderHostFrame(rig.host, 0.05);
    handle.cancel();
    renderHostFrame(rig.host, 0);
    near(rig.value(), 0, 'canceled mixed AU releases its native contribution');
    rig.host.setAUMixWeight(210, 0.25);
    renderHostFrame(rig.host, 0);
    near(rig.host.getAUMixWeight(210), 0.25, 'canonical mix weight updates');
    near(rig.value(), 0.25, 'changed Rust output starts a new native contribution');
    renderHostFrame(rig.host, 0.1);
    near(rig.value(), 0.25, 'canceled action does not reappear');
  } finally { rig.dispose(); }
});

test('editing mixed AU morph strength preserves its running bone transition', async () => {
  const rig = await fixture();
  const rotation = fraction => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 6 * fraction);
  try {
    const done = observe(rig.host.transitionAU(210, 1, 1000));
    renderHostFrame(rig.host, 0.25);
    nearRotation(rig.bone.quaternion, rotation(0.25), 'bone reaches its quarter sample');
    rig.host.setAUMixWeight(210, 0.5);
    renderHostFrame(rig.host, 0);
    near(rig.value(), 0.5, 'morph strength applies to the accepted target');
    nearRotation(rig.bone.quaternion, rotation(0.25), 'morph-only command does not replace the bone action');
    await settled(done, false, 'replacing the morph leaves the grouped bone transition pending');
    renderHostFrame(rig.host, 0.25);
    nearRotation(rig.bone.quaternion, rotation(0.5), 'bone keeps its original native timeline');
    near(rig.value(), 0.5, 'morph keeps its new strength');
    renderHostFrame(rig.host, 0.5);
    nearRotation(rig.bone.quaternion, rotation(1), 'bone reaches its original endpoint');
    await settled(done, true, 'group completes when its remaining bone action finishes');
  } finally { rig.dispose(); }
});

test('a semantic pose replaces canceled body transition properties', async () => {
  const rig = await bodyFixture();
  const { host, mesh, left, right } = rig;
  try {
    const targetPose = { version: 1, controls: [
      { controlId: 'body.elbowFlex', positive: { intensity: 0.4, balance: 0, morphStrength: 0.5 } },
    ] };
    host.applySemanticPose(targetPose);
    renderHostFrame(host, 0);
    const expectedLeft = left.quaternion.clone();
    const expectedRight = right.quaternion.clone();
    host.clear();
    host.setAUMixWeight(1001, 1);
    const handle = host.transitionAU(1001, 1, 200, -1);
    renderHostFrame(host, 0.05);
    near(mesh.morphTargetInfluences[0], 0.25, 'body transition reaches its native quarter sample');
    handle.cancel();
    renderHostFrame(host, 0);
    near(mesh.morphTargetInfluences[0], 0, 'body transition releases on cancel');
    host.applySemanticPose(targetPose);
    renderHostFrame(host, 0);
    near(mesh.morphTargetInfluences[0], 0.2, 'semantic pose takes over left morph');
    near(mesh.morphTargetInfluences[1], 0.2, 'semantic pose takes over right morph');
    nearRotation(left.quaternion, expectedLeft, 'semantic pose reclaims the held left bone');
    nearRotation(right.quaternion, expectedRight, 'semantic pose applies the right bone normally');
    renderHostFrame(host, 0.1);
    near(mesh.morphTargetInfluences[0], 0.2, 'semantic pose survives the next frame');
    host.resetBodyControls();
    renderHostFrame(host, 0);
    near(mesh.morphTargetInfluences[0], 0, 'body reset releases semantic output');
    near(left.quaternion.x, 0, 'body reset releases the bone');
  } finally { rig.dispose(); }
});

test('body reset keeps a canceled zero-target release neutral without clearing facial controls', async () => {
  const rig = await bodyFixture();
  const { host, mesh, left } = rig;
  try {
    host.setAUMixWeight(1001, 1);
    host.setAU(1001, 1, -1);
    host.setAU(12, 0.3);
    renderHostFrame(host, 0);
    const handle = host.transitionAU(1001, 0, 200, -1);
    renderHostFrame(host, 0.1);
    near(mesh.morphTargetInfluences[0], 0.5, 'native body release is halfway faded');
    handle.cancel();
    renderHostFrame(host, 0);
    near(host.getAU(1001), 0, 'body target is already neutral');
    near(mesh.morphTargetInfluences[0], 0, 'cancel releases the remaining body contribution');
    host.resetBodyControls();
    renderHostFrame(host, 0);
    near(mesh.morphTargetInfluences[0], 0, 'explicit reset keeps the body morph neutral');
    nearRotation(left.quaternion, new Quaternion(), 'explicit reset keeps the body rotation neutral');
    near(host.getAU(12), 0.3, 'unrelated facial semantic state remains');
    near(mesh.morphTargetInfluences[2], 0.3, 'unrelated facial output remains');
    renderHostFrame(host, 0.1);
    near(mesh.morphTargetInfluences[0], 0, 'neutral body does not reacquire the held pose');
    near(mesh.morphTargetInfluences[3], 0.3, 'other facial side remains');
  } finally { rig.dispose(); }
});

for (const canceled of [false, true]) {
  test(`an equal-target semantic command replaces a ${canceled ? 'canceled' : 'running'} body transition`, async () => {
    const rig = await bodyFixture();
    const { host, mesh } = rig;
    try {
      host.setAUMixWeight(1001, 1);
      host.setAU(12, 0.3);
      const handle = host.transitionAU(1001, 0.8, 200, -1);
      const done = observe(handle);
      renderHostFrame(host, 0.1);
      near(mesh.morphTargetInfluences[0], 0.4, 'rendered body is halfway to its target');
      if (canceled) { handle.cancel(); renderHostFrame(host, 0); }
      near(host.getAU(1001), 0.8, 'canonical body state already equals the new request');
      near(mesh.morphTargetInfluences[0], canceled ? 0 : 0.4, 'cancel releases only the native contribution');
      host.applySemanticPose({ version: 1, controls: [
        { controlId: 'body.elbowFlex', positive: { intensity: 0.8, balance: -1, morphStrength: 1 } },
      ] });
      renderHostFrame(host, 0);
      await settled(done, true, 'semantic ownership replacement resolves the old handle');
      near(mesh.morphTargetInfluences[0], 0.8, 'explicit semantic command takes effect despite unchanged canonical values');
      near(mesh.morphTargetInfluences[1], 0, 'other body side stays neutral');
      near(host.getAU(12), 0.3, 'facial state is not cleared by body replacement');
      renderHostFrame(host, 0.1);
      near(mesh.morphTargetInfluences[0], 0.8, 'body replacement remains authoritative');
      near(mesh.morphTargetInfluences[2], 0.3, 'unrelated facial rendering remains');
    } finally { rig.dispose(); }
  });
}

test('a semantic body command reclaims a canceled direct morph action with the same packed target', async () => {
  const rig = await bodyFixture();
  const { host, mesh } = rig;
  try {
    host.setAU(12, 0.3);
    const handle = host.transitionMorph('LL_Body_Bicep_Flex_L', 1, 200);
    const done = observe(handle);
    renderHostFrame(host, 0.1);
    near(mesh.morphTargetInfluences[0], 0.5, 'direct body morph reaches its midpoint');
    handle.cancel();
    renderHostFrame(host, 0);
    near(mesh.morphTargetInfluences[0], 0, 'canceled direct morph releases');
    host.applySemanticPose({ version: 1, controls: [
      { controlId: 'body.elbowFlex', positive: { intensity: 1, balance: -1, morphStrength: 1 } },
    ] });
    renderHostFrame(host, 0);
    await settled(done, true, 'reclaimed direct transition remains settled');
    near(mesh.morphTargetInfluences[0], 1, 'explicit body command reclaims even when packed target remains one');
    near(host.getAU(12), 0.3, 'facial state remains independent');
    renderHostFrame(host, 0.1);
    near(mesh.morphTargetInfluences[0], 1, 'canceled direct action cannot overwrite semantic command on later frame');
    near(mesh.morphTargetInfluences[2], 0.3, 'left facial output remains');
    near(mesh.morphTargetInfluences[3], 0.3, 'right facial output remains');
  } finally { rig.dispose(); }
});

for (const operation of ['clear', 'bindModel', 'setProfile', 'dispose']) {
  test(`${operation} settles pending control handles and leaves no later transition writes`, async () => {
    const rig = await fixture();
    try {
      const done = observe(rig.host.transitionAU(200, 1, 200));
      renderHostFrame(rig.host, 0.05);
      if (operation === 'dispose') rig.dispose();
      else if (operation === 'setProfile') rig.host.setProfile(structuredClone(profile));
      else rig.host[operation]();
      if (operation !== 'dispose') renderHostFrame(rig.host, 0);
      await settled(done, true, `${operation} resolves pending transition`);
      const expected = operation === 'bindModel' ? 1 : 0;
      near(rig.value(), expected, `${operation} retains its documented semantic-state policy`);
      if (operation !== 'dispose') {
        renderHostFrame(rig.host, 0.5);
        near(rig.value(), expected, `${operation} prevents obsolete action output`);
      }
    } finally { rig.dispose(); }
  });
}

test('replacing the model settles old transitions and rebinds their canonical targets to the new reference', async () => {
  const rig = await fixture();
  const replacement = makeModel(0.2);
  try {
    const handle = rig.host.transitionAU(200, 1, 200);
    const done = observe(handle);
    renderHostFrame(rig.host, 0.05);
    near(rig.value(), 0.25, 'old model has a pending transition');
    rig.host.onReady({ model: replacement.model });
    await settled(done, true, 'replacing the binding settles the old handle');
    renderHostFrame(rig.host, 0);
    near(rig.value(), 0, 'old model returns to its own reference');
    near(rig.host.getAU(200), 1, 'accepted target survives model replacement');
    near(replacement.mesh.morphTargetInfluences[0], 1, 'new model renders retained target');
    handle.cancel();
    renderHostFrame(rig.host, 0.3);
    near(replacement.mesh.morphTargetInfluences[0], 1, 'old handle cannot cancel the new binding');
    near(rig.value(), 0, 'old model receives no further transition writes');
    rig.host.setProfile(structuredClone(profile));
    renderHostFrame(rig.host, 0);
    near(rig.host.getAU(200), 0, 'profile replacement clears canonical controls');
    near(replacement.mesh.morphTargetInfluences[0], 0.2, 'profile replacement restores the new model reference');
  } finally {
    rig.dispose();
    replacement.mesh.geometry.dispose();
    replacement.mesh.material.dispose();
  }
});

for (const command of ['setter', 'replacement']) {
  test(`a public completion ${command} safely replaces a transition after native sampling`, async () => {
    const rig = await fixture();
    try {
      // The public action is activated first. Its notification must wait until
      // every native action has sampled before replacing a live transition.
      const publicClip = rig.play(1, [0.2, 0.8], 0.1, false);
      let callbacks = 0;
      let replacement;
      publicClip.subscribe(event => {
        if (event.type !== 'completed') return;
        callbacks++;
        if (command === 'setter') rig.host.setAU(200, 0.6);
        else replacement = observe(rig.host.transitionAU(200, 0.6, 200));
      });
      const previous = observe(rig.host.transitionAU(200, 1, 500));
      renderHostFrame(rig.host, 0.05);
      assert.doesNotThrow(() => renderHostFrame(rig.host, 0.05), 'retirement does not mutate Three action traversal');
      assert.equal(callbacks, 1, 'completion is delivered by the end of the native frame');
      await settled(previous, true, 'callback retires prior transition');
      near(rig.value(1), 0.8, 'the public clip writes its completed sample');
      renderHostFrame(rig.host, 0);
      if (command === 'setter') {
        near(rig.value(), 0.6, 'callback setter applies on the following native sample');
      } else {
        near(rig.value(), 0.2, 'replacement begins from the completed frame’s live sample');
        renderHostFrame(rig.host, 0.2);
        near(rig.value(), 0.6, 'replacement reaches its target');
        await settled(replacement, true, 'replacement settles normally');
      }
    } finally { rig.dispose(); }
  });
}
