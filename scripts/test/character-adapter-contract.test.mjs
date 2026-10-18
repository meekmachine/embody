import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnimationClip, Bone, BufferGeometry, Group, Mesh, MeshBasicMaterial,
  NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack,
} from 'three';
import {
  captureModelReferencePose, createRustEmbodyHostUnbound, getPreset,
  resolveRegionCameraAngle, supportsRustEmbodyPreset,
} from '@lovelace_lol/embody/three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import { renderHostFrame } from './helpers/render-playback.mjs';

await initEmbodyCore();

// These host contracts previously lived in Polymer's direct-runtime CLJS tests.
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-5,
  `${message}: expected ${expected}, received ${actual}`);
const rotationNear = (actual, expected, message) =>
  near(actual.clone().normalize().angleTo(expected.clone().normalize()), 0, message);
const profile = {
  auToMorphs: { 200: { center: ['Smile'], left: [], right: [] } },
  morphToMesh: { face: ['Face'] }, hairPhysics: { enabled: false },
};
function mesh(name, morphs = [], base = 0) {
  const result = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  result.name = name;
  if (morphs.length) {
    result.morphTargetDictionary = Object.fromEntries(morphs.map((key, index) => [key, index]));
    result.morphTargetInfluences = morphs.map(() => base);
  }
  return result;
}
function model(base = 0, angle = 0.2) {
  const root = new Group();
  const face = mesh('Face', ['Smile', 'Other', 'Mouth_Smile_L'], base);
  const head = new Bone(); head.name = 'Head'; head.rotation.x = angle; head.position.y = 2;
  root.add(face, head);
  return { root, face, head };
}
function disposeModel(root) {
  root.traverse(object => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    for (const material of [object.material].flat()) material.dispose();
  });
}
function fixture(t, { base = 0, config, rig = model(base) } = {}) {
  const host = createRustEmbodyHostUnbound(config ?? { profileMode: 'profile', profile: structuredClone(profile) });
  t.after(() => { host.dispose(); disposeModel(rig.root); });
  host.onReady({ model: rig.root });
  return { ...rig, host, value: () => rig.face.morphTargetInfluences[0] };
}
const morphClip = (name, values, duration = 1) => new AnimationClip(name, duration, [
  new NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, duration], values),
]);
const curves = (start, end, duration = 1, inherit = false) => ({
  200: [{ time: 0, intensity: start, inherit }, { time: duration, intensity: end }],
});

test('native registry retains added sources across rebind and rejects invalid replacements atomically', t => {
  const { host, value } = fixture(t);
  const first = morphClip('first', [0.3, 0.3]);
  const added = morphClip('added', [0.8, 0.8]);
  const original = AnimationClip.toJSON(first);
  host.loadAnimationClips([first]);
  const initialMetadata = host.getAnimationClips();
  host.removeAnimationClip('first');
  host.registerAnimationClips([first]);
  assert.deepEqual(host.getAnimationClips(), initialMetadata, 'initial and optional registration expose the same catalog');
  host.registerAnimationClips([added]);
  const invalid = morphClip('first', [0.9, 0.9]); invalid.duration = NaN;
  assert.throws(() => host.registerAnimationClips([invalid]));
  host.bindModel();
  assert.deepEqual(new Set(host.getAnimationClips().map(clip => clip.name)), new Set(['first', 'added']));
  host.playAnimation('first', { loop: true }); renderHostFrame(host, 0.2);
  near(value(), 0.3, 'failed registration retains the old source');
  host.setAnimationBlendMode('first', 'additive'); renderHostFrame(host, 1.1);
  assert.equal(host.getAnimationState('first').playing, true, 'blend edit preserves repeating playback');
  assert.ok(host.getAnimationState('first').time < 1);
  host.stopAllAnimations();
  host.playAnimation('added', { loop: true }); renderHostFrame(host, 0.2);
  near(value(), 0.8, 'optional source survives rebind');
  host.removeAnimationClip('first'); host.removeAnimationClip('added'); host.bindModel();
  assert.deepEqual(host.getAnimationClips(), []);
  assert.throws(() => host.playAnimation('added'), /Unknown animation clip/);
  assert.deepEqual(AnimationClip.toJSON(first), original, 'registration and playback preserve the source');
});

test('normal same-name replacement inherits the current rendered sample', t => {
  const { host, value } = fixture(t);
  host.playSnippet('inherited', curves(0, 1), { loop: false, blendMode: 'replace' });
  renderHostFrame(host, 0.4);
  host.playSnippet('inherited', curves(0, 0, 1, true), { loop: false, blendMode: 'replace' });
  renderHostFrame(host, 0); near(value(), 0.4, 'replacement starts at the outgoing sample');
  renderHostFrame(host, 0.5); near(value(), 0.2, 'replacement reaches its own midpoint');
});

for (const kind of ['curves', 'typed', 'native']) {
  test(`${kind} intensity overdrives authored values and edits the running action without seeking`, t => {
    const { host, value } = fixture(t);
    const points = [{ time: 0, intensity: 0 }, { time: 0.2, intensity: 0.5 }, { time: 1, intensity: 0.5 }];
    const options = { loop: false, intensityScale: 2 };
    let original, clip;
    if (kind === 'native') {
      clip = new AnimationClip('strong', 1, [new NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 0.2, 1], [0, 0.5, 0.5])]);
      original = AnimationClip.toJSON(clip);
      host.registerAnimationClips([clip]); host.playAnimation('strong', options);
    } else if (kind === 'typed') {
      host.playTypedSnippet({ name: 'strong', channels: [{ target: { type: 'au', id: 200 }, keyframes: points }] }, options);
    } else host.playSnippet('strong', { 200: points }, options);
    renderHostFrame(host, 0.3); near(value(), 1, '2x authored strength');
    const before = host.getAnimationState('strong');
    host.setAnimationIntensity('strong', 1.5); renderHostFrame(host, 0.1);
    near(value(), 0.75, 'live strength edit');
    const after = host.getAnimationState('strong');
    assert.equal(after.actionId, before.actionId); assert.ok(after.time > before.time);
    assert.equal(after.intensityScale, 1.5); assert.equal(after.mixerWeight, 1);
    if (clip) assert.deepEqual(AnimationClip.toJSON(clip), original);
  });
}

test('baked quaternion strength extrapolates from the captured reference', t => {
  const { host, head } = fixture(t);
  const rest = head.quaternion.clone();
  const authored = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1);
  const clip = new AnimationClip('turn', 1, [new QuaternionKeyframeTrack('Head.quaternion', [0, 1], [...rest.toArray(), ...authored.toArray()])]);
  host.registerAnimationClips([clip]); host.playAnimation('turn', { intensityScale: 2 });
  renderHostFrame(host, 0.5); rotationNear(head.quaternion, authored, 'twice the midpoint delta');
  host.setAnimationIntensity('turn', 0); renderHostFrame(host, 0);
  rotationNear(head.quaternion, rest, 'zero intensity restores the captured reference');
});

for (const explicit of [false, true]) {
  test(`additive strength uses ${explicit ? 'the explicit authored frame' : 'the captured model reference'}`, t => {
    const { host, value } = fixture(t);
    const clip = new AnimationClip('additive', 1, [new NumberKeyframeTrack('Face.morphTargetInfluences[0]', [0, 0.2, 1], [0.2, 0.5, 0.5])]);
    const original = AnimationClip.toJSON(clip);
    host.registerAnimationClips([clip]);
    host.playAnimation('additive', { blendMode: 'additive', intensityScale: 2, ...(explicit ? { additiveReferenceTimeSec: 0 } : {}) });
    renderHostFrame(host, 0.3); near(value(), explicit ? 0.6 : 1, 'authored additive delta');
    assert.deepEqual(AnimationClip.toJSON(clip), original);
  });
}

test('profile mode replaces exact mappings without importing a preset', t => {
  const { host, face } = fixture(t);
  host.setAU(200, 0.75); host.setAU(12, 1); renderHostFrame(host, 0);
  near(face.morphTargetInfluences[0], 0.75, 'exact profile mapping');
  near(face.morphTargetInfluences[2], 0, 'CC4 facial mapping is absent');
  assert.equal(host.getProfileMode(), 'profile'); assert.equal(host.getPresetId(), null);
  host.setProfile({ ...profile, name: 'Replacement', auToMorphs: { 201: { center: ['Other'] } } });
  host.setAU(201, 0.5); renderHostFrame(host, 0);
  near(face.morphTargetInfluences[0], 0, 'old profile contribution released');
  near(face.morphTargetInfluences[1], 0.5, 'replacement mapping renders');
  assert.equal(host.getProfile().name, 'Replacement');
  assert.equal(host.getProfile().meshes, undefined);
});

test('preset selection and authored mix defaults survive profile replacement', t => {
  for (const id of ['cc4', 'fish']) assert.equal(supportsRustEmbodyPreset(id), true);
  for (const id of ['default', 'human', 'skeletal', 'custom']) assert.equal(supportsRustEmbodyPreset(id), false);
  const { host } = fixture(t, { config: { presetId: 'cc4', profile: { auMixDefaults: { 61: 0.25 } } } });
  assert.equal(host.getProfileMode(), 'preset'); assert.equal(host.getPresetId(), 'cc4');
  near(host.getAUMixWeight(61), 0.25, 'profile overrides preset');
  near(host.getAUMixWeight(62), 0.5, 'unmodified preset default');
  host.setAUMixWeight(61, 1);
  assert.equal(host.getProfile().auMixDefaults[61], 1);
  host.setProfile(JSON.parse(JSON.stringify(host.getProfile())));
  assert.equal(host.getAUMixWeight(61), 1);
});

test('an unspecified annotation camera angle remains absent', () => {
  assert.equal(resolveRegionCameraAngle({ name: 'left_eye' }, { leftSideX: -1 }), undefined,
    'an omitted camera angle stays omitted');
});

test('body descriptors are cached and morph strength does not weaken the mapped joint', t => {
  const bodyProfile = getPreset('cc4');
  for (const [role, name] of [['leftLowerArm', 'CustomForearmL'], ['rightLowerArm', 'CustomForearmR']]) {
    bodyProfile.boneNodes[bodyProfile.humanoidCharacterization.roles[role].nodeKey] = name;
  }
  bodyProfile.bonePrefix = ''; bodyProfile.boneSuffix = '';
  bodyProfile.auToMorphs[1001] = { left: ['FlexL'], right: ['FlexR'], center: [] };
  const root = new Group(), left = new Bone(), right = new Bone();
  left.name = 'CustomForearmL'; right.name = 'CustomForearmR';
  const body = mesh('CC_Base_Body', ['FlexL', 'FlexR']); root.add(left, right, body);
  const host = createRustEmbodyHostUnbound({ profileMode: 'profile', profile: JSON.parse(JSON.stringify(bodyProfile)) });
  t.after(() => { host.dispose(); disposeModel(root); });
  assert.deepEqual(host.getBodyControls(), []);
  host.onReady({ model: root });
  const traverse = root.traverse;
  root.traverse = () => { throw new Error('descriptor reads must not traverse the scene'); };
  try {
    const controls = host.getBodyControls(); assert.equal(controls.length, 58);
    const elbow = controls.find(control => control.auId === 1001);
    assert.equal(elbow.isMixed, true); assert.deepEqual(elbow.diagnostics, []);
  } finally { root.traverse = traverse; }
  host.setAUMixWeight(1001, 1); host.setAU(1001, 0.5, 1); renderHostFrame(host, 0);
  near(left.quaternion.x, 0, 'left side excluded'); near(right.quaternion.x, 0.5, 'right elbow rotates');
  near(body.morphTargetInfluences[1], 0.5, 'right tissue follows');
  host.setAUMixWeight(1001, 0.25); renderHostFrame(host, 0);
  near(body.morphTargetInfluences[1], 0.125, 'morph strength scales tissue');
  near(right.quaternion.x, 0.5, 'joint strength is unchanged');
  host.setAU(12, 0.4); host.resetBodyControls(); renderHostFrame(host, 0);
  near(host.getAU(12), 0.4, 'body reset preserves unrelated facial state');
  assert.equal(host.getAUBalance(1001), 0); assert.equal(host.getAUMixWeight(1001), 0.25);
  near(right.quaternion.x, 0, 'body reset releases rotation');
});

for (const preset of ['cc4', 'fish']) {
  test(`${preset} host applies static mesh categories and saves material and visibility edits`, t => {
    const root = new Group();
    const names = preset === 'fish' ? ['BODY_0', 'EYES_0', 'Cube_0'] : ['CC_Base_Body_1', 'CC_Base_Eye', 'CC_Base_EyeOcclusion_1'];
    const objects = names.map(name => mesh(name)); root.add(...objects);
    const { host } = fixture(t, { rig: { root }, config: { presetId: preset } });
    assert.deepEqual(host.getMeshList().map(entry => entry.category), preset === 'fish' ? ['body', 'eye', 'body'] : ['body', 'eye', 'eyeOcclusion']);
    if (preset === 'fish') assert.deepEqual(objects.map(object => object.renderOrder), [20, 17, -20]);
    else { assert.equal(objects[1].renderOrder, -10); assert.equal(objects[2].renderOrder, 2); }
    host.setMeshVisible(names[0], false);
    host.setMeshMaterialConfig(names[0], { renderOrder: 41, opacity: 0.25, transparent: true, depthWrite: false });
    const saved = host.getProfile().meshes[names[0]];
    assert.equal(saved.category, 'body'); assert.equal(saved.visible, false);
    assert.equal(saved.material.renderOrder, 41); assert.equal(saved.material.opacity, 0.25);
    assert.equal(saved.material.depthWrite, false);
    assert.equal(objects[0].visible, false); assert.equal(objects[0].renderOrder, 41);
    near(objects[0].material.opacity, 0.25, 'material edit renders');
  });
}

test('optional registration preserves active native, snippet, and configured hair actions', t => {
  const rig = model();
  const hair = mesh('Hair', ['Sway_Custom', 'L_Hair_Right', 'L_Hair_Front']);
  hair.material.color.set('#abcdef'); rig.root.add(hair);
  const { host, face } = fixture(t, { rig, config: { presetId: 'cc4', profile: {
    ...profile, meshes: { Hair: { category: 'hair' } },
    hairPhysics: { enabled: true, idleSwayAmount: 0.3, stiffness: 4.25, morphTargets: { swayLeft: { key: 'Sway_Custom', axis: 'yaw' } } },
  } } });
  assert.equal(host.getRegisteredHairObjects().length, 1);
  assert.ok(host.getHairMorphTargets('Hair').includes('Sway_Custom'));
  assert.equal(host.getHairAppearance().hairColor.baseColor, '#abcdef');
  near(host.getHairPhysicsConfig().stiffness, 4.25, 'authored hair configuration');
  host.setHairBaseColor('#112233'); assert.equal(hair.material.color.getHexString(), '112233');
  host.registerAnimationClips([new AnimationClip('native', 2, [new VectorKeyframeTrack('Face.position', [0, 2], [0, 0, 0, 2, 0, 0])])]);
  const native = host.playAnimation('native', { loop: true, fadeInSec: 0.5, fadeOutSec: 0.2 });
  host.playSnippet('gesture', curves(0, 1, 2), { loop: true });
  renderHostFrame(host, 0.1);
  const names = ['native', 'gesture', '__embody_hair_idle'];
  const before = names.map(name => host.getAnimationState(name));
  host.registerAnimationClips([morphClip('optional', [0.8, 0.8])]);
  names.forEach((name, index) => {
    const after = host.getAnimationState(name);
    assert.equal(after.actionId, before[index].actionId); near(after.time, before[index].time, `${name} is not restarted`);
  });
  renderHostFrame(host, 0.5);
  names.forEach((name, index) => assert.ok(host.getAnimationState(name).time > before[index].time, `${name} advances`));
  near(host.getAnimationState('native').mixerWeight, 1, 'pending native fade completes');
  near(face.position.x, 0.6, 'native sample keeps advancing');
  near(face.morphTargetInfluences[0], 0.3, 'snippet keeps advancing');
  assert.equal(host.getAnimationState('optional').playing, false);
  native.stop(); host.registerAnimationClips([morphClip('later', [0.4, 0.4])]);
  renderHostFrame(host, 0.3); assert.equal(host.getAnimationState('native').playing, false);
  near(face.position.x, 0, 'registration retains pending stop');
  host.setHairPhysicsEnabled(false); assert.equal(host.isHairPhysicsEnabled(), false);
});

test('profile edits and rebinding keep the first reference used by native strength', t => {
  const { host, root, head } = fixture(t);
  const rest = head.quaternion.clone();
  const clip = new AnimationClip('turn', 1, [new QuaternionKeyframeTrack('Head.quaternion', [0, 1], [...rest.toArray(), ...new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1).toArray()])]);
  host.registerAnimationClips([clip]); host.playAnimation('turn', { loop: true }); renderHostFrame(host, 0.5);
  assert.ok(head.quaternion.angleTo(rest) > 0.3);
  for (const rebind of [() => host.setProfile({ ...profile, name: 'Edited' }), () => host.bindModel(), () => host.onReady({ model: root })]) {
    head.rotation.x = 1.3; head.position.y = 9; rebind();
    rotationNear(host.bones.Head.baseQuat, rest, 'reference is not recaptured');
    near(host.bones.Head.basePos.y, 2, 'authored reference position');
  }
  host.playAnimation('turn', { loop: true, intensityScale: 0 }); renderHostFrame(host, 0.3);
  rotationNear(head.quaternion, rest, 'zero strength uses first reference after edits');
});

test('explicit references survive host recreation and only initialize the matching first model', t => {
  const first = model(0.15, 0.2), second = model(0.25, 0.6);
  const hosts = [];
  t.after(() => { for (const host of hosts) host.dispose(); disposeModel(first.root); disposeModel(second.root); });
  const capture = captureModelReferencePose(first.root);
  const reference = first.head.quaternion.clone(), secondReference = second.head.quaternion.clone();
  const old = createRustEmbodyHostUnbound({ profileMode: 'profile', profile });
  hosts.push(old);
  old.onReady({ model: first.root, referencePose: capture });
  first.head.rotation.x = 1.1; first.face.morphTargetInfluences[0] = 0.8; old.dispose();
  const host = createRustEmbodyHostUnbound({ profileMode: 'profile', profile, referencePose: capture });
  hosts.push(host);
  host.onReady({ model: first.root, animations: [morphClip('smile', [0.15, 1])] });
  rotationNear(host.bones.Head.baseQuat, reference, 'recreated host uses explicit reference');
  host.playAnimation('smile', { loop: true, intensityScale: 0 }); renderHostFrame(host, 0.3);
  near(first.face.morphTargetInfluences[0], 0.15, 'explicit morph reference survives recreation');
  host.onReady({ model: second.root });
  rotationNear(host.bones.Head.baseQuat, secondReference, 'constructor reference does not override another model');
  host.onReady({ model: first.root });
  rotationNear(host.bones.Head.baseQuat, reference, 'switching back preserves the first model reference');
});

test('reference extension preserves existing bones and rejected reinspection keeps active playback', t => {
  const { host, root, head } = fixture(t);
  const rest = head.quaternion.clone(); head.rotation.x = 1.1;
  const added = new Bone(); added.name = 'Added'; added.rotation.z = 0.4;
  const addedRest = added.quaternion.clone(); root.add(added);
  assert.throws(() => host.bindModel(), /Incompatible reference pose hierarchy/);
  host.extendReferencePose();
  added.rotation.z = 0.9; host.setProfile({ ...profile, name: 'Extended' });
  rotationNear(host.bones.Head.baseQuat, rest, 'extension preserves existing reference');
  rotationNear(host.bones.Added.baseQuat, addedRest, 'extension captures only appended bone');
  host.registerAnimationClips([new AnimationClip('move', 1, [new VectorKeyframeTrack('Head.position', [0, 1], [0, 2, 0, 0, 4, 0])])]);
  host.playAnimation('move', { loop: true }); renderHostFrame(host, 0.25);
  const before = head.position.y, saved = host.getProfile(); head.name = 'Renamed';
  assert.throws(() => host.setProfile({ name: 'Rejected' }), /Incompatible reference pose hierarchy/);
  assert.throws(() => host.bindModel(), /Incompatible reference pose hierarchy/);
  assert.equal(host.getProfile(), saved); assert.equal(host.getAnimationState('move').playing, true);
  renderHostFrame(host, 0.25); assert.ok(head.position.y > before, 'failed inspection leaves action intact');
});

test('explicit native fades pause with mixer time and stop releases a fading action', t => {
  const { host, value } = fixture(t);
  const handle = host.playSnippet('fade', curves(1, 1, 2), { fadeInSec: 0.2, fadeOutSec: 0.2, easing: 'easeInOut' });
  host.setAnimationTimeScale(0); renderHostFrame(host, 0.3); near(value(), 0, 'mixer pause freezes fade-in');
  host.setAnimationTimeScale(1); renderHostFrame(host, 0.1); near(value(), 0.5, 'native fade midpoint');
  renderHostFrame(host, 0.11); near(value(), 1, 'fade-in completes');
  handle.stop(); host.setAnimationTimeScale(0); renderHostFrame(host, 0.3);
  near(value(), 1, 'mixer pause freezes release');
  host.setAnimationTimeScale(1); renderHostFrame(host, 0.21); near(value(), 0, 'release restores reference');
  assert.equal(host.getAnimationState('fade').playing, false);
  const early = host.playSnippet('early', curves(1, 1, 2), { fadeInSec: 0.2, fadeOutSec: 0.2 });
  renderHostFrame(host, 0.03); assert.ok(value() > 0 && value() < 0.5);
  early.stop(); renderHostFrame(host, 0.21); near(value(), 0, 'stop during fade-in releases the action');
});

test('explicit release and crossfade retire completed poses without implicit track takeover', t => {
  const { host, value } = fixture(t);
  const pulse = { 200: [{ time: 0, intensity: 0 }, { time: 0.2, intensity: 1 }, { time: 0.4, intensity: 0 }] };
  host.playSnippet('pulseA', pulse, { finalPose: 'release' }); renderHostFrame(host, 0.5);
  host.playSnippet('pulseB', pulse, { finalPose: 'release' }); renderHostFrame(host, 0.2);
  near(value(), 1, 'released pulse does not dilute its successor'); host.stopAllAnimations();
  host.registerAnimationClips([morphClip('held', [0.8, 0.8], 0.2), morphClip('next', [1, 1])]);
  host.playAnimation('held', { finalPose: 'hold' }); renderHostFrame(host, 0.3);
  near(value(), 0.8, 'explicit held pose');
  host.crossfadeTo('next', 0.2, { loop: true }); renderHostFrame(host, 0.1);
  near(value(), 0.9, 'native crossfade blends outgoing and incoming poses');
  renderHostFrame(host, 0.11); near(value(), 1, 'crossfade releases the held action');
  assert.equal(host.getAnimationState('held').actionId, undefined);
  host.stopAllAnimations();
  for (const strength of [1, 0.6, 0.2]) {
    host.playSnippet('replacement', curves(strength, strength), { fadeInSec: 0.1, easing: 'easeInOut' });
    renderHostFrame(host, 0.02);
  }
  renderHostFrame(host, 0.2); near(value(), 0.2, 'rapid same-name replacements release every previous action');
});
