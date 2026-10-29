import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AnimationClip, Bone, BufferGeometry, Group, Mesh, MeshBasicMaterial,
  InterpolateDiscrete, NumberKeyframeTrack, Quaternion, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack,
} from 'three';
import {
  captureModelReferencePose, createRustEmbodyHostUnbound, getPreset,
  renderScenePlayback, resolveRegionCameraAngle, serializeAnimationClips,
  supportsRustEmbodyPreset, ThreeModelInspector,
} from '@lovelace_lol/embody/three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import { createPlaybackTimer, renderHostFrame } from './helpers/render-playback.mjs';

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
const distanceGoal = end => curves(0, end, 1, true);
const distanceOptions = (timing = {}, options = {}) => ({
  blendMode: 'additive', loopMode: 'once', finalPose: 'hold', fadeInSec: 0, fadeOutSec: 0,
  ...options, distanceTiming: { unitsPerSecond: 1, ...timing },
});

test('ordinary inherited AU requests derive remaining distance from the native action without live AU mutation', t => {
  const { host, value } = fixture(t);
  assert.equal(host.animationCapabilities.distanceTiming, true);
  assert.equal(Object.isFrozen(host.animationCapabilities), true);
  const live = host.getAU(200);
  host.playSnippet('distance', distanceGoal(1), distanceOptions());
  renderHostFrame(host, 0.4); near(value(), 0.4, 'native current contribution');
  host.playSnippet({ name: 'distance', curves: distanceGoal(0.6) }, distanceOptions());
  near(host.getAnimationState('distance').duration, 0.2, 'only the remaining AU distance determines duration');
  renderHostFrame(host, 0); near(value(), 0.4, 'inherited first key preserves native contribution');
  renderHostFrame(host, 0.1); near(value(), 0.5, 'ordinary native linear midpoint');
  near(host.getAU(200), live, 'measurement never copies playback samples into canonical live AU state');
});

test('distance timing applies a minimum and adds reversal delay only before native completion', t => {
  const { host, value } = fixture(t);
  const options = distanceOptions({ minimumDurationSec: 0.8, reversalExtraSec: 0.2 });
  host.playSnippet('reversal', distanceGoal(1), options); renderHostFrame(host, 0.4);
  host.playSnippet('reversal', distanceGoal(0), options);
  near(host.getAnimationState('reversal').duration, 1, 'unfinished reversal adds 0.2 to the minimum 0.8');
  renderHostFrame(host, 1.01); near(value(), 0, 'native completion holds the destination');
  host.playSnippet('reversal', distanceGoal(0.4), options);
  near(host.getAnimationState('reversal').duration, 0.8, 'a held completed request has no reversal penalty');
});

test('identical nonzero held goals use a microhold despite native Float32 precision and a minimum duration', t => {
  const { host, value } = fixture(t);
  const options = distanceOptions({ minimumDurationSec: 0.8, reversalExtraSec: 0.2 });
  host.playSnippet('same-held', distanceGoal(0.65), options); renderHostFrame(host, 1);
  host.playSnippet('same-held', distanceGoal(0.65), options);
  near(host.getAnimationState('same-held').duration, 1e-6, 'identical Float32 endpoint has exactly zero semantic distance');
  renderHostFrame(host, 0); near(value(), 0.65, 'microhold preserves the held contribution');
});

const continuumProfile = (paired = true) => ({
  ...structuredClone(profile),
  auToMorphs: { 201: { center: ['Smile'], left: [], right: [] }, 202: { center: ['Other'], left: [], right: [] } },
  ...(paired ? { continuumPairs: {
    201: { pairId: 202, isNegative: true, axis: 'yaw', node: 'Head' },
    202: { pairId: 201, isNegative: false, axis: 'yaw', node: 'Head' },
  } } : {}),
});
const continuumGoal = (negative, positive) => ({
  201: [{ time: 0, intensity: 0, inherit: true }, { time: 1, intensity: negative }],
  202: [{ time: 0, intensity: 0, inherit: true }, { time: 1, intensity: positive }],
});

test('distance timing measures a paired goal crossing neutral along its signed continuum', t => {
  const { host } = fixture(t, { config: { profileMode: 'profile', profile: continuumProfile() } });
  host.playSnippet('continuum', continuumGoal(0.3, 0), distanceOptions()); renderHostFrame(host, 0.31);
  host.playSnippet('continuum', continuumGoal(0, 0.3), distanceOptions());
  near(host.getAnimationState('continuum').duration, 0.6, 'negative 0.3 to positive 0.3 is 0.6 continuum units');
  renderHostFrame(host, 0.61);
  host.playSnippet('continuum', continuumGoal(0, 0.5), distanceOptions());
  near(host.getAnimationState('continuum').duration, 0.2, 'a one-sided move keeps its AU distance');
  renderHostFrame(host, 0.21);
  host.playSnippet('continuum', continuumGoal(0, 0.5), distanceOptions());
  near(host.getAnimationState('continuum').duration, 1e-6, 'an identical held continuum goal remains zero-distance');
});

test('distance timing detects a continuum reversal and leaves unpaired AUs on per-AU distance', t => {
  const paired = fixture(t, { config: { profileMode: 'profile', profile: continuumProfile() } }).host;
  const options = distanceOptions({ reversalExtraSec: 0.2 });
  paired.playSnippet('reversal', continuumGoal(0.6, 0), options); renderHostFrame(paired, 0.2);
  paired.playSnippet('reversal', continuumGoal(0, 0.2), options);
  near(paired.getAnimationState('reversal').duration, 0.6, 'negative 0.2 to positive 0.2 plus the unfinished reversal');
  const unpaired = fixture(t, { config: { profileMode: 'profile', profile: continuumProfile(false) } }).host;
  unpaired.playSnippet('independent', continuumGoal(0.3, 0), distanceOptions()); renderHostFrame(unpaired, 0.31);
  unpaired.playSnippet('independent', continuumGoal(0, 0.3), distanceOptions());
  near(unpaired.getAnimationState('independent').duration, 0.3, 'independent AUs keep the largest per-AU distance');
});

test('distance timing measures only its own additive contribution while another clip shares its output', t => {
  const { host, value } = fixture(t);
  host.registerAnimationClips([morphClip('independent-base', [0.2, 0.2], 2)]);
  const other = host.playAnimation('independent-base', { loop: true });
  host.playSnippet('own-axis', distanceGoal(0.8), distanceOptions()); renderHostFrame(host, 0.3);
  near(value(), 0.5, 'independent clip and axis both contribute');
  const otherId = other.actionId;
  host.playSnippet('own-axis', distanceGoal(0.4), distanceOptions());
  near(host.getAnimationState('own-axis').duration, 0.1, 'distance excludes the other clip contribution');
  renderHostFrame(host, 0); near(value(), 0.5, 'replacement does not inherit the other clip a second time');
  assert.equal(host.getAnimationState('independent-base').actionId, otherId);
  renderHostFrame(host, 0.11); near(value(), 0.6, 'independent contribution stays active after axis arrival');
});

test('custom composite bone and morph mappings keep their Rust outputs when destination strength becomes zero', t => {
  const rig = model(); rig.head.name = 'SavedSwivel'; rig.face.name = 'SavedSurface';
  const savedProfile = {
    boneNodes: { SAVED_SWIVEL: 'SavedSwivel' },
    auToBones: {
      901: [{ node: 'SAVED_SWIVEL', channel: 'ry', scale: -1, maxDegrees: 37 }],
      902: [{ node: 'SAVED_SWIVEL', channel: 'rz', scale: 1, maxDegrees: 23 }],
    },
    compositeRotations: [{ node: 'SAVED_SWIVEL',
      yaw: { aus: [901], axis: 'ry' }, roll: { aus: [902], axis: 'rz' } }],
    auToMorphs: { 901: { center: ['Smile'] }, 902: { center: ['Other'] } },
    morphToMesh: { face: ['SavedSurface'] }, auMixDefaults: { 901: 0.7, 902: 0.6 },
    hairPhysics: { enabled: false },
  };
  const { host, head, face } = fixture(t, { rig, config: { profileMode: 'profile', profile: savedProfile } });
  host.setAU(901, 0.15); renderHostFrame(host, 0);
  const baseline = { rotation: head.quaternion.clone(), morphs: [...face.morphTargetInfluences], au: host.getAU(901) };
  const goal = { 901: [{ time: 0, intensity: 0, inherit: true }, { time: 1, intensity: 1 }],
    902: [{ time: 0, intensity: 0, inherit: true }, { time: 1, intensity: 0.5 }] };
  const options = distanceOptions({}, { balanceMap: { 901: 0, 902: 0 }, mixWeights: { 901: 0.25, 902: 0.75 } });
  host.playSnippet('saved-rig', goal, options); renderHostFrame(host, 1.01);
  assert.ok(head.quaternion.angleTo(baseline.rotation) > 0.1, 'saved custom composite rotations remain active');
  assert.ok(face.morphTargetInfluences[0] > baseline.morphs[0], 'the same AU also preserves its morph output');
  assert.ok(face.morphTargetInfluences[1] > baseline.morphs[1], 'the second custom AU retains its own morph');
  const beforeZero = { rotation: head.quaternion.clone(), morphs: [...face.morphTargetInfluences] };
  host.playSnippet('saved-rig', goal, { ...options, intensityScale: 0 });
  near(host.getAnimationState('saved-rig').duration, 1, 'zero strength still travels the remaining semantic distance');
  renderHostFrame(host, 0);
  rotationNear(head.quaternion, beforeZero.rotation, 'zero scales only the destination, not the inherited start');
  near(face.morphTargetInfluences[0], beforeZero.morphs[0], 'mapped morph continuity at zero-strength replacement');
  renderHostFrame(host, 1.01);
  rotationNear(head.quaternion, baseline.rotation, 'custom composite contribution releases toward native neutral');
  baseline.morphs.forEach((amount, index) => near(face.morphTargetInfluences[index], amount, 'mapped morph returns to its independent baseline'));
  near(host.getAU(901), baseline.au, 'playback never rewrites live AU state');
  near(host.getProfile().auMixDefaults[901], 0.7, 'explicit clip mixWeights do not rewrite saved morph defaults');
});

test('cleared AU mappings retain semantic timing without inventing native bone or morph outputs', t => {
  const { host, value, head } = fixture(t, { config: { profileMode: 'profile', profile: {} } });
  const rest = head.quaternion.clone();
  host.playSnippet('unmapped-axis', distanceGoal(0.8), distanceOptions());
  near(host.getAnimationState('unmapped-axis').duration, 0.8, 'unmapped controls still own their requested native duration');
  renderHostFrame(host, 0.3);
  host.playSnippet('unmapped-axis', distanceGoal(0.2), distanceOptions());
  near(host.getAnimationState('unmapped-axis').duration, 0.1, 'semantic native interpolant survives an empty output clip');
  renderHostFrame(host, 0.11); near(value(), 0, 'cleared mapping creates no morph output');
  rotationNear(head.quaternion, rest, 'cleared mapping creates no bone output');
  near(host.getAU(200), 0, 'semantic timing creates no duplicate live AU owner');
});

test('distance timing rejects unsupported requests and in-place semantic edits before replacing native work', t => {
  const { host, value } = fixture(t);
  const handle = host.playSnippet('validated', distanceGoal(1), distanceOptions()); renderHostFrame(host, 0.25);
  const before = host.getAnimationState('validated'), catalog = host.getAnimationClips();
  const invalid = [
    [distanceGoal(0), distanceOptions({ unitsPerSecond: 0 })],
    [distanceGoal(0), distanceOptions({ unitsPerSecond: NaN })],
    [distanceGoal(0), distanceOptions({ unitsPerSecond: Number.MIN_VALUE })],
    [distanceGoal(0), distanceOptions({ unitsPerSecond: 1e-100 })],
    [distanceGoal(0), distanceOptions({ minimumDurationSec: 1e100 })],
    [distanceGoal(0), distanceOptions({ unknown: true })],
    [distanceGoal(0), distanceOptions({}, { easing: 'easeInOut' })],
    [distanceGoal(0), distanceOptions({}, { mixerWeight: 0.5 })],
    [distanceGoal(0), distanceOptions({}, { fadeInSec: 0.1 })],
    [distanceGoal(0), distanceOptions({}, { speed: 2 })],
    [curves(0, 0, 1, false), distanceOptions()],
    [{ '0200': distanceGoal(0)[200] }, distanceOptions()],
    [{ jaw: distanceGoal(0)[200] }, distanceOptions()],
    [{ 201: distanceGoal(0)[200] }, distanceOptions()],
    [distanceGoal(0), distanceOptions({}, { balanceMap: { 200: -1 } })],
  ];
  for (const [goal, options] of invalid) {
    assert.throws(() => host.playSnippet('validated', goal, options), /distanceTiming/);
    assert.equal(host.getAnimationState('validated').actionId, before.actionId);
    near(host.getAnimationState('validated').time, before.time, 'rejection neither replaces nor seeks');
    assert.deepEqual(host.getAnimationClips(), catalog, 'invalid capability requests do not replace the source catalog');
  }
  for (const patch of [{ intensityScale: 0 }, { speed: 2 }, { easing: 'easeOut' },
    { distanceTiming: { unitsPerSecond: 2 } }, { mixWeights: { 200: 0.5 } }]) {
    assert.throws(() => handle.updateParams(patch), /distanceTiming/);
    assert.equal(host.getAnimationState('validated').actionId, before.actionId);
  }
  assert.throws(() => host.playTypedSnippet({ name: 'typed-distance', channels: [{ target: { type: 'au', id: 200 },
    keyframes: distanceGoal(1)[200] }] }, distanceOptions()), /ordinary numeric AU curves/);
  host.playSnippet('unrelated', curves(0, 1), { blendMode: 'additive' });
  const unrelated = host.getAnimationState('unrelated');
  assert.throws(() => host.playSnippet('unrelated', distanceGoal(0), distanceOptions()), /predecessor/);
  assert.equal(host.getAnimationState('unrelated').actionId, unrelated.actionId);
  renderHostFrame(host, 0.1); assert.ok(value() > 0.25, 'rejected requests leave native playback advancing');
});

test('prepared admission, pause, seek, replay, stop and binding replacement retain native lifecycle ownership', t => {
  const { host, value } = fixture(t);
  host.playSnippet('lifecycle-distance', distanceGoal(1), distanceOptions()); renderHostFrame(host, 0.25);
  const previousId = host.getAnimationState('lifecycle-distance').actionId;
  const prepared = host.buildClip('lifecycle-distance', distanceGoal(0.75), distanceOptions());
  assert.equal(host.getAnimationState('lifecycle-distance').actionId, previousId, 'preparing owns no new native play');
  assert.throws(() => prepared.updateParams({ speed: 2 }), /distanceTiming/);
  renderHostFrame(host, 0.25); prepared.play();
  near(host.getAnimationState('lifecycle-distance').duration, 0.25, 'measurement occurs at actual play, not build');
  renderHostFrame(host, 0.1); prepared.pause();
  const paused = host.getAnimationState('lifecycle-distance').time;
  renderHostFrame(host, 0.2); near(host.getAnimationState('lifecycle-distance').time, paused, 'pause leaves the native clock stationary');
  host.seekAnimation('lifecycle-distance', 0.05); renderHostFrame(host, 0); near(value(), 0.55, 'ordinary native seek samples the same admitted curve');
  prepared.play();
  near(host.getAnimationState('lifecycle-distance').time, 0, 'fresh play does not carry an earlier seek offset');
  near(host.getAnimationState('lifecycle-distance').duration, 0.2, 'fresh play uses actual sought native contribution');
  renderHostFrame(host, 0.3); prepared.resume();
  near(host.getAnimationState('lifecycle-distance').duration, 1e-6, 'held resume remains a valid fresh zero-distance admission');
  prepared.stop(); prepared.play();
  near(host.getAnimationState('lifecycle-distance').duration, 0.75, 'stop retires the predecessor instead of retaining a pose ledger');
  host.bindModel();
  assert.throws(() => prepared.play(), /obsolete model binding/);
  host.playSnippet('lifecycle-distance', distanceGoal(0.5), distanceOptions());
  near(host.getAnimationState('lifecycle-distance').duration, 0.5, 'new binding starts without stale native contribution');
  host.dispose();
  assert.throws(() => host.playSnippet('disposed-distance', distanceGoal(0.5), distanceOptions()), /disposed/);
});

test('live morph-mix changes reject incompatible inheritance while explicit clip overrides remain authoritative', t => {
  const { host } = fixture(t);
  host.playSnippet('mix-default', distanceGoal(1), distanceOptions()); renderHostFrame(host, 0.2);
  const before = host.getAnimationState('mix-default');
  host.setAUMixWeight(200, 0.4);
  const catalog = host.getAnimationClips();
  assert.throws(() => host.playSnippet('mix-default', distanceGoal(0.5), distanceOptions()), /predecessor/);
  assert.equal(host.getAnimationState('mix-default').actionId, before.actionId);
  assert.deepEqual(host.getAnimationClips(), catalog, 'incompatible defaults reject before changing the Rust source registry');
  host.playSnippet('explicit-mix', distanceGoal(1), distanceOptions({}, { mixWeights: { 200: 0.7 } }));
  renderHostFrame(host, 0.2); host.setAUMixWeight(200, 0.2);
  host.playSnippet('explicit-mix', distanceGoal(0.5), distanceOptions({}, { mixWeights: { 200: 0.7 } }));
  near(host.getAnimationState('explicit-mix').duration, 0.3, 'unchanged explicit mix weights preserve their own measurement basis');
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

test('packed morph registration and profile replacement allocate only component-sized sample buffers', t => {
  const widths = [];
  class ObservedTrack extends NumberKeyframeTrack {
    constructor(name, times, values, interpolation) {
      super(name, times, values, interpolation);
      widths.push(values.length);
    }
  }
  const root = new Group();
  const face = mesh('Face', Array.from({ length: 24 }, (_, index) => `Morph${index}`));
  root.add(face);
  const { host } = fixture(t, { rig: { root, face } });
  const times = [0, 0.25, 0.75, 1];
  const values = times.flatMap((_, sample) => face.morphTargetInfluences.map((_, index) => (sample + index + 1) / 100));
  const clip = new AnimationClip('packed', 1, [
    new ObservedTrack('Face.morphTargetInfluences', times, values, InterpolateDiscrete),
  ]);
  const original = AnimationClip.toJSON(clip);
  for (const operation of [
    () => host.registerAnimationClips([clip]),
    () => host.setProfile({ ...profile, morphToMesh: { face: [] } }),
  ]) {
    widths.length = 0;
    operation();
    assert.ok(widths.length >= face.morphTargetInfluences.length, 'packed components were materialized');
    assert.ok(widths.every(length => length === times.length), 'conversion never clones the full packed values per morph');
    host.playAnimation('packed', { loopMode: 'repeat' });
    renderHostFrame(host, 0.5);
    near(face.morphTargetInfluences[0], 0.02, 'step sample survives conversion and replacement');
    near(face.morphTargetInfluences[23], 0.25, 'last packed component keeps its own sample');
  }
  assert.deepEqual(AnimationClip.toJSON(clip), original, 'packed sources remain unchanged');
});

test('catalog serialization indexes morphs once and shares destination searches only within that call', t => {
  const { root, face, head } = fixture(t);
  const inspector = new ThreeModelInspector();
  const inspection = inspector.inspectModel(root);
  const morphBindings = inspection.morphBindings;
  let bindingPasses = 0;
  inspection.morphBindings = new class extends Map {
    *[Symbol.iterator]() { bindingPasses += 1; yield* super[Symbol.iterator](); }
  }(morphBindings);
  const searches = [];
  const findObject = root.getObjectByProperty;
  root.getObjectByProperty = function (property, value) {
    searches.push(value);
    return findObject.call(this, property, value);
  };
  const clips = ['one', 'two', 'three'].map(name => new AnimationClip(name, 1, [
    new NumberKeyframeTrack('Face.morphTargetInfluences[Smile]', [0, 1], [0.1, 0.7], InterpolateDiscrete),
    new NumberKeyframeTrack('Face.morphTargetInfluences[1]', [0, 1], [0.2, 0.8]),
    new QuaternionKeyframeTrack('Head.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new VectorKeyframeTrack('Face.position', [0, 1], [0, 0, 0, 1, 2, 3]),
    new NumberKeyframeTrack('Face.visible', [0, 1], [1, 0]),
    new NumberKeyframeTrack('Missing.morphTargetInfluences[0]', [0, 1], [0, 1]),
    new NumberKeyframeTrack('Face.morphTargetInfluences[MissingMorph]', [0, 1], [0, 1]),
    new NumberKeyframeTrack('Face.morphTargetInfluences[999]', [0, 1], [0, 1]),
  ]));
  const original = clips.map(clip => AnimationClip.toJSON(clip));
  const serialized = serializeAnimationClips(root, clips, inspection);
  assert.equal(bindingPasses, 1, 'morph inventory is indexed once for the entire catalog');
  assert.equal(searches.length, clips[0].tracks.length, 'each repeated track destination is resolved once, including missing nodes');
  const morphId = index => [...morphBindings].find(([, binding]) => binding.mesh === face && binding.index === index)[0];
  const meshId = [...inspection.meshBindings].find(([, mesh]) => mesh === face)[0];
  const boneId = [...inspection.boneBindings].find(([, bone]) => bone === head)[0];
  const objectId = [...inspection.objectBindings].find(([, object]) => object === face)[0];
  for (const clip of serialized) {
    assert.deepEqual(clip.tracks.map(track => track.target), [
      { kind: 'morphTarget', meshId, morphTargetId: morphId(0) },
      { kind: 'morphTarget', meshId, morphTargetId: morphId(1) },
      { kind: 'boneTransform', boneId, property: 'rotation' },
      { kind: 'objectTransform', objectId, property: 'position' },
      { kind: 'meshVisibility', meshId },
    ], 'unresolved nodes, morph names and indices are omitted without changing valid destinations');
    assert.equal(clip.tracks[0].interpolation, 'step');
    near(clip.tracks[0].values[1], 0.7, 'serialized sample');
  }
  assert.deepEqual(clips.map(clip => AnimationClip.toJSON(clip)), original);
  face.name = 'RetiredFace';
  const secondInspection = inspector.inspectModel(root);
  const reserialized = serializeAnimationClips(root, clips, secondInspection);
  assert.ok(reserialized.every(clip => clip.tracks.length === 1 && clip.tracks[0].target.boneId === boneId),
    'a subsequent call resolves renamed model nodes instead of retaining old destinations');
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

test('mesh selection replacement preserves unchanged material programs and clears excluded morph output', t => {
  const configured = { ...structuredClone(profile), meshes: { Face: { material: { opacity: 0.7, transparent: true } } } };
  const { host, face, value } = fixture(t, { config: { profileMode: 'profile', profile: configured } });
  const version = face.material.version;
  host.setAU(200, 1); renderHostFrame(host, 0);
  near(value(), 1, 'selected face receives the authored AU');
  host.setProfile({ ...configured, morphToMesh: { face: [] } });
  renderHostFrame(host, 0);
  near(value(), 0, 'deselecting the face releases the previous output');
  assert.equal(face.material.version, version, 'mapping edits do not invalidate unchanged materials');
  host.setAU(200, 1); renderHostFrame(host, 0);
  near(value(), 0, 'explicit empty selection stays empty');
  host.setProfile({ ...configured, meshes: { Face: { material: { opacity: 0.4, transparent: true } } } });
  assert.equal(face.material.opacity, 0.4);
  assert.ok(face.material.version > version, 'authored material changes still reach the renderer');
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
  assert.deepEqual(host.getAUDescriptors(), []);
  host.onReady({ model: root });
  const traverse = root.traverse;
  root.traverse = () => { throw new Error('descriptor reads must not traverse the scene'); };
  try {
    const controls = host.getAUDescriptors(); assert.ok(controls.length > 0);
    const elbow = controls.find(control => control.auId === 1001);
    assert.equal(elbow.hasBones && elbow.hasMorphs, true); assert.deepEqual(elbow.diagnostics, []);
  } finally { root.traverse = traverse; }
  host.setAUMixWeight(1001, 1); host.setAU(1001, 0.5, 1); renderHostFrame(host, 0);
  near(left.quaternion.x, 0, 'left side excluded'); near(right.quaternion.x, 0.5, 'right elbow rotates');
  near(body.morphTargetInfluences[1], 0.5, 'right tissue follows');
  host.setAUMixWeight(1001, 0.25); renderHostFrame(host, 0);
  near(body.morphTargetInfluences[1], 0.125, 'morph strength scales tissue');
  near(right.quaternion.x, 0.5, 'joint strength is unchanged');
  host.setAU(12, 0.4); host.setAU(1001, 0, 0); renderHostFrame(host, 0);
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

function trackingHairFixture(t, { hairConfig = {}, headRole = true, hairInitial = 0 } = {}) {
  const rig = model(0, 0);
  const names = ['SwayLeft', 'SwayRight', 'SwayFront', 'FluffRight', 'FluffBottom', 'HeadUp', 'HeadDown'];
  const hair = mesh('TrackingHair', names, hairInitial); rig.root.add(hair);
  const savedProfile = {
    boneNodes: { SAVED_HEAD: 'Head' },
    humanoidCharacterization: { schemaVersion: 1, standard: 'VRMC_vrm-1.0', roles: { head: { nodeKey: 'SAVED_HEAD' } } },
    auToBones: {
      901: [{ node: 'SAVED_HEAD', channel: 'ry', scale: 1, maxDegrees: 30 }],
      902: [{ node: 'SAVED_HEAD', channel: 'rx', scale: 1, maxDegrees: -30 }],
    },
    compositeRotations: [{ node: 'SAVED_HEAD', yaw: { aus: [901], axis: 'ry' }, pitch: { aus: [902], axis: 'rx' } }],
    meshes: { TrackingHair: { category: 'hair' } },
    hairPhysics: { enabled: true, inertia: 1, gravity: 1, responseScale: 1,
      idleSwayAmount: 0.2, idleClipDuration: 2, impulseClipDuration: 0.75, stiffness: 4.25, damping: 0.8,
      // Saved profiles retain authored target metadata; the runtime config API
      // separately normalizes these records to names and numeric weights.
      morphTargets: { swayLeft: { key: 'SwayLeft', axis: 'yaw' }, swayRight: { key: 'SwayRight', axis: 'yaw' },
        swayFront: { key: 'SwayFront', axis: 'pitch' }, fluffRight: { key: 'FluffRight', axis: 'yaw' },
        fluffBottom: { key: 'FluffBottom', axis: 'pitch' },
        headUp: { HeadUp: { value: 1, axis: 'pitch' } }, headDown: { HeadDown: { value: 1, axis: 'pitch' } } }, ...hairConfig },
  };
  if (!headRole) delete savedProfile.humanoidCharacterization;
  const f = fixture(t, { rig, config: { profileMode: 'profile', profile: savedProfile } });
  // Only an actual post-mixer observation establishes the initial head pose.
  renderHostFrame(f.host, 0);
  return { ...f, hair, amount: name => hair.morphTargetInfluences[names.indexOf(name)],
    follow(axis, destination) {
      return f.host.playSnippet(`follow-${axis}`, {
        [axis === 'yaw' ? 901 : 902]: [{ time: 0, intensity: 0, inherit: true }, { time: 1, intensity: destination }],
      }, distanceOptions());
    } };
}

const responseName = '__embody_hair_response';
const hairValues = f => [...f.hair.morphTargetInfluences];
const sameHair = (actual, expected, message) => actual.forEach((value, index) => near(value, expected[index], `${message}, morph ${index}`));
function advanceHair(f, frames, seconds = 1 / 60) {
  for (let frame = 0; frame < frames; frame++) renderHostFrame(f.host, seconds);
}
function responseId(f) {
  const id = f.host.getAnimationState(responseName).actionId;
  assert.ok(id, 'enabled mapped hair has one persistent native response action');
  return id;
}
function noAutomaticHairClips(host) {
  for (const name of ['__embody_hair_idle', '__embody_hair_impulse', '__embody_hair_gravity']) {
    assert.equal(host.getAnimationState(name).actionId, undefined, `${name} is not a second automatic owner`);
  }
}

function cc4HairFixture(t) {
  // Keep the embedded preset's actual dynamics, direction and ambient tuning.
  // Only its model-specific morph names are supplied by this small test rig.
  const { morphTargets, ...hairConfig } = structuredClone(getPreset('cc4').hairPhysics);
  return trackingHairFixture(t, { hairConfig });
}

function fastHairTurn(f, destination, duration, native = false) {
  if (!native) {
    return f.host.playSnippet('cc4-fast-yaw', {
      901: [{ time: 0, intensity: 0, inherit: true }, { time: duration, intensity: destination }],
    }, { blendMode: 'additive', loopMode: 'once', finalPose: 'hold', fadeInSec: 0, fadeOutSec: 0 });
  }
  const end = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), destination * Math.PI / 6);
  const clip = new AnimationClip('cc4-fast-yaw', duration, [new QuaternionKeyframeTrack(
    'Head.quaternion', [0, duration], [...f.head.quaternion.toArray(), ...end.toArray()],
  )]);
  f.host.registerAnimationClips([clip]);
  return f.host.playAnimation(clip.name, { loopMode: 'once', finalPose: 'hold', fadeInSec: 0, fadeOutSec: 0 });
}

test('embedded CC4 tuning keeps fast AU and native turn/return output continuous at irregular cadence', t => {
  const saved = cc4HairFixture(t), native = cc4HairFixture(t);
  const ids = [saved, native].map(responseId), cadenceTicks = [1, 3, 2, 4];
  const scale = getPreset('cc4').hairPhysics.responseScale;
  // Rust caps spring velocity at 10; the C1 direction mapping has maximum
  // slope 4/3, and the concrete output knee never increases that slope.
  const maximumMorphSpeed = 10 * scale * 4 / 3;
  let previous = hairValues(saved), largest = 0;
  for (const destination of [0.9, 0, 0.9, 0, 0.7, 0]) {
    fastHairTurn(saved, destination, 0.1); fastHairTurn(native, destination, 0.1, true);
    let ticks = 0, frame = 0;
    while (ticks < 30) {
      const step = Math.min(cadenceTicks[frame++ % cadenceTicks.length], 30 - ticks), dt = step / 120;
      ticks += step;
      for (const f of [saved, native]) {
        renderHostFrame(f.host, dt);
        // Observe the newly staged response through its next native sample;
        // this zero-delta sample does not advance the Rust simulation.
        renderHostFrame(f.host, 0);
      }
      rotationNear(native.head.quaternion, saved.head.quaternion, 'both admissions produce the same actual head trajectory');
      const current = hairValues(saved);
      sameHair(hairValues(native), current, 'hair responds to actual mixed pose rather than the admission API');
      current.forEach((value, index) => {
        assert.ok(Number.isFinite(value) && value >= 0 && value <= 2, 'native CC4 response remains finite and bounded');
        assert.ok(Math.abs(value - previous[index]) <= maximumMorphSpeed * dt + 2e-5,
          'morph changes respect the continuous spring and mapping slope bound');
      });
      largest = Math.max(largest, ...current); previous = current;
      [saved, native].forEach((f, index) => assert.equal(responseId(f), ids[index], 'retargeting never restarts the response action'));
    }
  }
  assert.ok(largest > 0.05, 'the real preset exercises an observable response');
  noAutomaticHairClips(saved.host); noAutomaticHairClips(native.host);

  const strong = cc4HairFixture(t), strongId = responseId(strong), values = [];
  strong.host.playHairImpulse(4, 0);
  for (let frame = 0; frame < 60; frame++) {
    renderHostFrame(strong.host, 1 / 120); renderHostFrame(strong.host, 0);
    values.push(strong.amount('SwayLeft'));
    assert.equal(responseId(strong), strongId);
  }
  assert.ok(values.some(value => value > 1.5), 'moderate finite input reaches the soft output knee with actual CC4 gains');
  assert.ok(values.every(value => Number.isFinite(value) && value >= 0 && value < 2),
    'this finite input approaches the limit without clipping onto an exact 2 plateau');
  assert.ok(new Set(values.filter(value => value > 1.5)).size > 5, 'output keeps changing above the knee');
});

test('CC4 response agrees at matched times across 30, 60, 120 Hz and irregular renderer cadence', t => {
  const cadences = [[4], [2], [1], [1, 3, 2, 4]];
  const fixtures = cadences.map(() => cc4HairFixture(t)), ids = fixtures.map(responseId);
  let largest = 0;
  for (let quarter = 0; quarter < 12; quarter++) {
    if (quarter % 2 === 0) fixtures.forEach(f => fastHairTurn(f, quarter % 4 === 0 ? 0.9 : 0, 0.25));
    fixtures.forEach((f, index) => {
      let ticks = 0, frame = 0;
      while (ticks < 30) {
        const step = Math.min(cadences[index][frame++ % cadences[index].length], 30 - ticks);
        renderHostFrame(f.host, step / 120); ticks += step;
      }
      renderHostFrame(f.host, 0);
      assert.equal(responseId(f), ids[index]);
    });
    const reference = hairValues(fixtures[2]);
    largest = Math.max(largest, ...reference);
    fixtures.forEach(f => hairValues(f).forEach((value, index) => {
      // Common command/turn boundaries and observations use 1/120-second
      // ticks. Allow 0.25% of the output range for native Float32 samples and
      // implicit integration partitions, not a whole-frame phase offset.
      assert.ok(Math.abs(value - reference[index]) < 0.005, 'matched-time response is independent of renderer cadence');
    }));
  }
  assert.ok(largest > 0.05, 'cadence comparison includes moving and settling hair');
});

test('tiny opposite-direction responses approach neutral with zero slope', t => {
  const options = { hairConfig: { idleSwayAmount: 0, windStrength: 0, gravity: 0,
    stiffness: 0, damping: 0, inertia: 0, responseScale: 1 } };
  const full = trackingHairFixture(t, options), half = trackingHairFixture(t, options), opposite = trackingHairFixture(t, options);
  full.host.playHairImpulse(0.01, 0); half.host.playHairImpulse(0.005, 0); opposite.host.playHairImpulse(-0.01, 0);
  for (const f of [full, half, opposite]) { advanceHair(f, 6, 1 / 120); renderHostFrame(f.host, 0); }
  const amount = full.amount('SwayLeft'), smaller = half.amount('SwayLeft');
  assert.ok(amount > 0 && amount < 0.00002, 'the fixture stays inside the documented 0.04 neutral transition band');
  assert.ok(smaller > amount * 0.2 && smaller < amount * 0.3,
    'halving tiny displacement gives approximately quarter output, rather than the old linear cusp');
  assert.ok(Math.abs(opposite.amount('SwayRight') - amount) < amount * 1e-4, 'directional neutral shaping is symmetric');
  assert.equal(full.amount('SwayRight'), 0); assert.equal(opposite.amount('SwayLeft'), 0);
});

test('continuous hair stages native output for the next sample and explicit impulses preserve one owner', t => {
  const options = { hairConfig: { idleSwayAmount: 0, windStrength: 0, gravity: 0 } };
  const f = trackingHairFixture(t, options), based = trackingHairFixture(t, { ...options, hairInitial: 0.2 });
  const id = responseId(f), initial = hairValues(f);
  assert.ok(initial.every(value => value === 0));
  sameHair(hairValues(based), initial.map(() => 0.2), 'zero Rust output preserves nonzero captured morph baselines');
  assert.equal(f.host.playHairImpulse(0.8, 0.4), undefined, 'compatibility impulse injects Rust velocity without a playback handle');
  based.host.playHairImpulse(0.8, 0.4);
  assert.equal(responseId(f), id);
  renderHostFrame(f.host, 1 / 60); renderHostFrame(based.host, 1 / 60);
  sameHair(hairValues(f), initial, 'this native sample precedes the post-mix Rust response');
  renderHostFrame(f.host, 0); renderHostFrame(based.host, 0);
  const staged = hairValues(f);
  assert.ok(staged.some(value => value > 0.001), 'the next native sample applies the staged continuous response');
  sameHair(hairValues(based).map(value => value - 0.2), staged, 'native response adds once to the reference instead of subtracting or duplicating it');
  renderHostFrame(f.host, 0);
  sameHair(hairValues(f), staged, 'zero-delta sampling neither advances nor accumulates the response');
  assert.equal(responseId(f), id);
  noAutomaticHairClips(f.host);
  f.host.stopAllAnimations(); advanceHair(f, 3);
  assert.equal(responseId(f), id, 'stop-all retains the persistent native response just like compiled live controls');
  assert.ok(hairValues(f).some((value, index) => Math.abs(value - staged[index]) > 0.0001),
    'the preserved spring continues settling after ordinary animations stop');
});

test('equivalent retargets and no-op numeric tuning preserve momentum and ambient phase', t => {
  const hairConfig = { idleSwayAmount: 0.15, windStrength: 0.1, stiffness: 15, damping: 8 };
  const changing = trackingHairFixture(t, { hairConfig }), uninterrupted = trackingHairFixture(t, { hairConfig });
  const changingId = responseId(changing), uninterruptedId = responseId(uninterrupted);
  changing.follow('yaw', 0.8); uninterrupted.follow('yaw', 0.8);
  let largestResponse = 0;
  for (let frame = 0; frame < 90; frame++) {
    if (frame % 2 === 0) changing.follow('yaw', 0.8);
    if ([12, 36, 60].includes(frame)) changing.host.setHairPhysicsConfig({ stiffness: 15, damping: 8 });
    renderHostFrame(changing.host, 1 / 60); renderHostFrame(uninterrupted.host, 1 / 60);
    rotationNear(changing.head.quaternion, uninterrupted.head.quaternion, 'equivalent requests retain the same observed head path');
    sameHair(hairValues(changing), hairValues(uninterrupted), 'redundant requests and tuning do not restart spring state or idle/wind phase');
    largestResponse = Math.max(largestResponse, ...hairValues(changing));
    assert.equal(responseId(changing), changingId);
    assert.equal(responseId(uninterrupted), uninterruptedId);
  }
  assert.ok(largestResponse > 0.001, 'comparison covers an active response rather than two static characters');
  noAutomaticHairClips(changing.host);
});

test('saved AU, live AU and native clips drive hair from the same mixed head motion', t => {
  const options = { hairConfig: { idleSwayAmount: 0, windStrength: 0, gravity: 0, stiffness: 15, damping: 8 } };
  const saved = trackingHairFixture(t, options), live = trackingHairFixture(t, options), native = trackingHairFixture(t, options);
  const ids = [saved, live, native].map(responseId);
  const savedMove = saved.follow('yaw', 0.8);
  const liveMove = live.host.transitionAU(901, 0.8, 800);
  const end = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 6 * 0.8);
  const clip = new AnimationClip('native-head-motion', 0.8, [
    new QuaternionKeyframeTrack('Head.quaternion', [0, 0.8], [0, 0, 0, 1, ...end.toArray()]),
  ]);
  native.host.registerAnimationClips([clip]);
  const nativeMove = native.host.playAnimation(clip.name, { blendMode: 'additive', loopMode: 'once', finalPose: 'hold' });
  let largestResponse = 0;
  for (let frame = 0; frame < 72; frame++) {
    if (frame === 24) { savedMove.pause(); liveMove.pause(); nativeMove.pause(); }
    for (const f of [saved, live, native]) renderHostFrame(f.host, 1 / 60);
    rotationNear(live.head.quaternion, saved.head.quaternion, 'live AU follows the saved AU head path');
    rotationNear(native.head.quaternion, saved.head.quaternion, 'native playback follows the saved AU head path');
    sameHair(hairValues(live), hairValues(saved), 'live AU and saved AU share the same hair observation');
    sameHair(hairValues(native), hairValues(saved), 'native clips and saved AU share the same hair observation');
    largestResponse = Math.max(largestResponse, ...hairValues(saved));
    [saved, live, native].forEach((f, index) => assert.equal(responseId(f), ids[index]));
  }
  assert.ok(largestResponse > 0.001, 'actual movement drives inertia while the head pause leaves hair free to settle');
  assert.equal(clip.tracks[0].name, 'Head.quaternion', 'observing native output does not rewrite the saved clip');
});

test('continuous gravity follows held actual pitch across yaw updates and settles back to neutral', t => {
  const options = { hairConfig: { idleSwayAmount: 0, windStrength: 0, stiffness: 15, damping: 8 } };
  const turning = trackingHairFixture(t, options), held = trackingHairFixture(t, options);
  const pitch = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -0.4);
  const playPose = (f, target, duration = 0.3) => {
    const clip = new AnimationClip('composed-head-pose', duration, [new QuaternionKeyframeTrack(
      'Head.quaternion', [0, duration], [...f.head.quaternion.toArray(), ...target.toArray()],
    )]);
    f.host.registerAnimationClips([clip]);
    return f.host.playAnimation(clip.name, { loopMode: 'once', finalPose: 'hold' });
  };
  playPose(turning, pitch); playPose(held, pitch);
  for (let frame = 0; frame < 180; frame++) {
    renderHostFrame(turning.host, 1 / 60); renderHostFrame(held.host, 1 / 60);
  }
  assert.ok(turning.amount('HeadUp') > 0.1, 'the observed pitched head establishes gravity');
  const id = responseId(turning);
  for (const yaw of [0.3, -0.2, 0.5]) {
    // YXZ rotation preserves actual decomposed pitch as yaw changes. Separate
    // additive pitch/yaw clips need not preserve that Euler pitch after blending.
    playPose(turning, new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw).multiply(pitch));
    for (let frame = 0; frame < 24; frame++) {
      renderHostFrame(turning.host, 1 / 60); renderHostFrame(held.host, 1 / 60);
      near(turning.amount('HeadUp'), held.amount('HeadUp'), 'yaw does not reset the ongoing pitch response');
      near(turning.amount('HeadDown'), held.amount('HeadDown'), 'yaw creates no opposite gravity');
      assert.equal(responseId(turning), id);
    }
  }
  playPose(turning, new Quaternion());
  advanceHair(turning, 240);
  assert.ok(turning.amount('HeadUp') < 0.001, 'continuous gravity settles after the actual head returns to neutral');
  assert.ok(turning.amount('HeadDown') < 0.001, 'returning to neutral creates no persistent opposite response');
});

test('native pause and global time scale govern the same continuous hair simulation', t => {
  const options = { hairConfig: { idleSwayAmount: 0.2, windStrength: 0.2, stiffness: 15, damping: 8 } };
  const paused = trackingHairFixture(t, options), reference = trackingHairFixture(t, options);
  const id = responseId(paused);
  for (let frame = 0; frame < 20; frame++) {
    renderHostFrame(paused.host, 1 / 60); renderHostFrame(reference.host, 1 / 60);
  }
  renderHostFrame(paused.host, 0); renderHostFrame(reference.host, 0);
  const before = hairValues(paused);
  paused.host.pauseAllAnimations(); advanceHair(paused, 12);
  sameHair(hairValues(paused), before, 'paused native response does not accumulate hidden spring or ambient time');
  paused.host.resumeAllAnimations();
  for (let frame = 0; frame < 12; frame++) {
    renderHostFrame(paused.host, 1 / 60); renderHostFrame(reference.host, 1 / 60);
    sameHair(hairValues(paused), hairValues(reference), 'resume continues the preserved phase');
  }
  renderHostFrame(paused.host, 0); renderHostFrame(reference.host, 0);
  const frozen = hairValues(paused);
  paused.host.setAnimationTimeScale(0); advanceHair(paused, 12);
  sameHair(hairValues(paused), frozen, 'zero mixer time scale also freezes continuous physics');
  paused.host.setAnimationTimeScale(2);
  for (let frame = 0; frame < 12; frame++) {
    renderHostFrame(paused.host, 1 / 60); renderHostFrame(reference.host, 1 / 30);
    sameHair(hairValues(paused), hairValues(reference), 'response uses effective native mixer delta');
  }
  const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4).toArray();
  const forward = new AnimationClip('reverse-observed-head', 1, [
    new QuaternionKeyframeTrack('Head.quaternion', [0, 1], [0, 0, 0, 1, ...turn]),
  ]);
  const reversed = new AnimationClip('reverse-observed-head', 1, [
    new QuaternionKeyframeTrack('Head.quaternion', [0, 1], [...turn, 0, 0, 0, 1]),
  ]);
  paused.host.registerAnimationClips([forward]); reference.host.registerAnimationClips([reversed]);
  for (const f of [paused, reference]) f.host.playAnimation('reverse-observed-head', { loopMode: 'repeat', time: 0.5 });
  paused.host.setAnimationTimeScale(-1); reference.host.setAnimationTimeScale(1);
  renderHostFrame(paused.host, 0); renderHostFrame(reference.host, 0);
  for (let frame = 0; frame < 12; frame++) {
    renderHostFrame(paused.host, 1 / 60); renderHostFrame(reference.host, 1 / 60);
    rotationNear(paused.head.quaternion, reference.head.quaternion, 'reversed native time follows the equivalent forward-authored path');
    sameHair(hairValues(paused), hairValues(reference), 'physics advances forward while observing actual reversed head movement');
  }
  assert.equal(responseId(paused), id);
});

test('rebinding primes the restored live head pose without creating a rest-to-pose impulse', t => {
  const f = trackingHairFixture(t, { hairConfig: { idleSwayAmount: 0, windStrength: 0, gravity: 0 } });
  f.host.setAU(901, 0.8); renderHostFrame(f.host, 0);
  const held = f.head.quaternion.clone(), oldId = responseId(f);
  f.host.bindModel();
  assert.notEqual(responseId(f), oldId, 'a new binding owns a new native response');
  renderHostFrame(f.host, 0);
  rotationNear(f.head.quaternion, held, 'live AU state is restored by native playback before priming');
  advanceHair(f, 12);
  assert.ok(hairValues(f).every(value => value === 0), 'the first observed held pose is a baseline rather than artificial velocity');
});

test('paused response intent survives cleared mappings and disable/re-enable without a hidden restart', t => {
  const f = trackingHairFixture(t, { hairConfig: { idleSwayAmount: 0, windStrength: 0, gravity: 0 } });
  f.host.playHairImpulse(0.8, 0.4); advanceHair(f, 6); renderHostFrame(f.host, 0);
  const before = hairValues(f), mappings = f.host.getHairPhysicsConfig().morphTargets;
  assert.ok(before.some(value => value > 0.001));
  f.host.pauseAllAnimations();
  f.host.setHairPhysicsConfig({ morphTargets: {} }); renderHostFrame(f.host, 0);
  assert.equal(f.host.getAnimationState(responseName).actionId, undefined);
  assert.ok(hairValues(f).every(value => value === 0), 'cleared mappings release old native targets even while paused');
  f.host.setHairPhysicsConfig({ morphTargets: mappings });
  assert.equal(f.host.getAnimationState(responseName).paused, true, 'rebuilt output inherits the single simulation pause intent');
  advanceHair(f, 6);
  sameHair(hairValues(f), before, 'mapping changes preserve paused displacement and velocity');
  f.host.setHairPhysicsEnabled(false); f.host.setHairPhysicsEnabled(true);
  assert.equal(f.host.getAnimationState(responseName).paused, true, 're-enable cannot clear an explicit pause');
  advanceHair(f, 6);
  assert.ok(hairValues(f).every(value => value === 0), 'disabled state resets and re-enable remains frozen');
  f.host.resumeAllAnimations(); f.host.playHairImpulse(0.8, 0.4); advanceHair(f, 3);
  assert.ok(hairValues(f).some(value => value > 0.001), 'explicit resume admits forward simulation again');
});

test('ambient hair without a head role stays isolated and owned output is released on disable and disposal', t => {
  const ambient = trackingHairFixture(t, { headRole: false, hairConfig: { idleSwayAmount: 0.2, windStrength: 0.2 } });
  const sibling = trackingHairFixture(t, { headRole: false, hairConfig: { idleSwayAmount: 0, windStrength: 0, gravity: 0 } });
  const firstId = responseId(ambient), siblingId = responseId(sibling);
  for (let frame = 0; frame < 30; frame++) {
    renderHostFrame(ambient.host, 1 / 60); renderHostFrame(sibling.host, 1 / 60);
  }
  assert.ok(hairValues(ambient).some(value => value > 0.001), 'idle and wind run without a mapped head');
  assert.ok(hairValues(sibling).every(value => value === 0), 'another character owns independent Rust state and settings');
  ambient.host.setHairPhysicsEnabled(false); renderHostFrame(ambient.host, 0);
  assert.equal(ambient.host.getAnimationState(responseName).actionId, undefined);
  assert.ok(hairValues(ambient).every(value => value === 0), 'disabled response releases its native property contribution');
  sibling.host.playHairImpulse(0.8, 0.2);
  for (let frame = 0; frame < 12; frame++) {
    renderHostFrame(ambient.host, 1 / 60); renderHostFrame(sibling.host, 1 / 60);
  }
  assert.ok(hairValues(ambient).every(value => value === 0));
  assert.ok(hairValues(sibling).some(value => value > 0.001), 'disabling one character leaves the other simulation running');
  assert.equal(responseId(sibling), siblingId);
  ambient.host.setHairPhysicsEnabled(true);
  assert.notEqual(responseId(ambient), firstId, 're-enable admits a new primed response after releasing the old one');
  advanceHair(ambient, 12);
  assert.ok(hairValues(ambient).some(value => value > 0.001));
  ambient.host.dispose();
  const released = hairValues(ambient), timer = createPlaybackTimer();
  assert.doesNotThrow(() => renderScenePlayback(ambient.root, timer.update(100)), 'disposed bindings cannot call a freed Rust core');
  sameHair(hairValues(ambient), released, 'disposed output remains released');
  advanceHair(sibling, 2); assert.equal(responseId(sibling), siblingId);
});

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
  const names = ['native', 'gesture', responseName];
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

test('highlight intent uses Rust snapshots on the existing render clock and clears native resources on rebind/dispose', () => {
  const model = new Group();
  const face = mesh('Face');
  model.add(face);
  const original = face.material;
  const host = createRustEmbodyHostUnbound({ profileMode: 'profile', profile: {} });
  try {
    host.onReady({ model });
    host.highlightMesh('Face');
    const overlay = face.children.find(child => child.isMesh);
    assert.ok(overlay);
    near(overlay.material.opacity, 0, 'initial frame does not jump to full strength');
    renderHostFrame(host, 0.2);
    near(overlay.material.opacity, 0.175, 'render clock advances the Rust fade without clips');
    host.highlightMesh(null);
    renderHostFrame(host, 0.2);
    near(overlay.material.opacity, 0.0875, 'interrupted fade starts from current strength');
    renderHostFrame(host, 0.2);
    assert.equal(face.children.length, 0);
    assert.equal(face.material, original);
    host.highlightMesh('Face');
    host.bindModel();
    assert.equal(face.children.length, 0, 'rebind clears renderer resources and Rust state');
    host.highlightMesh('Face');
  } finally {
    host.dispose();
    assert.equal(face.children.length, 0, 'disposal releases preview resources');
    assert.equal(face.material, original);
    face.geometry.dispose(); original.dispose();
  }
});
