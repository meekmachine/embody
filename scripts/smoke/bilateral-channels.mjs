import assert from 'node:assert/strict';
import { AnimationMixer, Bone, BufferGeometry, Float32BufferAttribute, Group, LoopOnce, Mesh, MeshBasicMaterial } from 'three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';
import { createAnimationClipFromClipIR, ThreeModelInspector } from '@lovelace_lol/embody/three';

// Consume the built public package. The same file also runs in a tarball
// consumer or against an immutable published preview without rebuilding it.
const wasm = await initEmbodyCore();
const model = new Group();
const geometry = new BufferGeometry();
geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3));
const mesh = new Mesh(geometry, new MeshBasicMaterial());
mesh.name = 'Face';
mesh.morphTargetDictionary = { Blink_L: 0, Blink_R: 1, Brow: 2, Talk: 3 };
mesh.morphTargetInfluences = [0, 0, 0, 0];
const left = new Bone(); left.name = 'Eye_L';
const right = new Bone(); right.name = 'Eye_R';
model.add(mesh, left, right);
const profile = {
  auToMorphs: { 43: { left: ['Blink_L'], right: ['Blink_R'] }, 1: { center: ['Brow'] } },
  morphToMesh: { face: ['Face'] },
  visemeKeys: ['Unused', 'Talk'],
  boneNodes: { EYE_L: 'Eye_L', EYE_R: 'Eye_R' },
  auToBones: { 61: [
    { node: 'EYE_L', channel: 'ry', scale: 1, maxDegrees: 60, side: 'left' },
    { node: 'EYE_R', channel: 'ry', scale: 1, maxDegrees: 60, side: 'right' },
  ] },
  compositeRotations: ['EYE_L', 'EYE_R'].map((node) => ({ node, yaw: { aus: [61], axis: 'ry' } })),
};
const inspection = new ThreeModelInspector().inspectModel(model, { profile });
const core = new wasm.RuntimeCore(0);
core.configure_with_profile(JSON.stringify(profile), JSON.stringify(inspection.descriptor));
const mixer = new AnimationMixer(model);
const near = (actual, expected, label) => assert(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
const curve = (end, inherit = false) => [{ time: 0, intensity: 0, inherit }, { time: 1, intensity: end }];
const channel = (id, balance, end, inherit = false) => ({ target: { type: 'au', id, balance }, keyframes: curve(end, inherit) });
const typed = (channels, options = {}) => JSON.parse(core.build_typed_clip('typed', JSON.stringify(channels), JSON.stringify(options)));
const legacy = (options) => JSON.parse(core.build_clip('legacy', JSON.stringify({ 43: curve(1) }), JSON.stringify(options)));
const play = (ir, at, check, initial = [0, 0, 0, 0]) => {
  mesh.morphTargetInfluences.splice(0, 4, ...initial);
  left.quaternion.identity(); right.quaternion.identity();
  const clip = createAnimationClipFromClipIR(ir, inspection);
  assert.equal(new Set(clip.tracks.map((track) => track.name)).size, clip.tracks.length, 'one concrete track per property');
  const action = mixer.clipAction(clip).setLoop(LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.update(at);
  check();
  action.stop(); mixer.uncacheClip(clip);
};
const eyelids = (l, r, label) => { near(mesh.morphTargetInfluences[0], l, `${label} left`); near(mesh.morphTargetInfluences[1], r, `${label} right`); };
try {
  // Both legacy balance forms still use -1 = left, +1 = right.
  for (const [balance, l, r] of [[-1, 1, 0], [0, 1, 1], [1, 0, 1]]) {
    play(legacy({ balance }), 1, () => eyelids(l, r, 'legacy balance'));
    play(legacy({ balance: -balance, balanceMap: { 43: balance } }), 1, () => eyelids(l, r, 'legacy map precedence'));
    play(typed([channel(43, balance, 1)], { balance: -balance, balanceMap: { 43: -balance } }), 1, () => eyelids(l, r, 'typed explicit balance'));
  }
  play(typed([{ target: { type: 'au', id: 43 }, keyframes: curve(1) }], { balance: -1 }), 1, () => eyelids(1, 0, 'typed global fallback'));
  play(typed([{ target: { type: 'au', id: 43 }, keyframes: curve(1) }], { balance: -1, balanceMap: { 43: 1 } }), 1, () => eyelids(0, 1, 'typed map fallback'));

  for (const inherit of [false, true]) for (const reverse of [false, true]) {
    const channels = [channel(43, -1, 0.3, inherit), channel(43, 1, 0.7, inherit)];
    if (reverse) channels.reverse();
    const ir = typed(channels);
    const unchanged = structuredClone(ir);
    play(ir, 1, () => eyelids(0.3, 0.7, 'independent channels'));
    if (inherit) {
      play(ir, 0.5, () => eyelids(0.55, 0.45, 'inherited midpoint'), [0.8, 0.2, 0, 0]);
      play(ir, 0.5, () => eyelids(0.25, 0.8, 'fresh replay midpoint'), [0.2, 0.9, 0, 0]);
    }
    assert.deepEqual(ir, unchanged, 'replay never mutates cached ClipIR');
  }

  // Opposite-side inheritance must not claim an explicit anchor, even when
  // that anchor is authored zero. Each side also keeps its own key times.
  for (const explicit of [0, 0.8]) {
    const mixed = typed([
      { target: { type: 'au', id: 43, balance: -1 }, keyframes: [{ time: 0, intensity: explicit }, { time: 1, intensity: explicit }] },
      { target: { type: 'au', id: 43, balance: 1 }, keyframes: [{ time: 0, intensity: 0, inherit: true }, { time: 0.5, intensity: 0.7 }] },
    ]);
    play(mixed, 0.25, () => eyelids(explicit, 0.55, 'mixed authored and inherited'), [0.2, 0.4, 0, 0]);
  }
  const zeroOwner = typed([
    { target: { type: 'au', id: 43, balance: -1 }, keyframes: [{ time: 0, intensity: 0.8 }, { time: 1, intensity: 0.8 }] },
    channel(43, 1, 0.7, true),
  ], { intensityScale: 0 });
  play(zeroOwner, 0.5, () => eyelids(0, 0.2, 'zero-gain explicit owner'), [0.2, 0.4, 0, 0]);
  const delayed = typed([
    { target: { type: 'au', id: 43, balance: -1 }, keyframes: [{ time: 0.2, intensity: 0, inherit: true }, { time: 1, intensity: 0.3 }] },
    { target: { type: 'au', id: 43, balance: 1 }, keyframes: [{ time: 0.2, intensity: 0, inherit: true }, { time: 0.5, intensity: 0.7 }] },
  ]);
  play(delayed, 0.1, () => eyelids(0.2, 0.4, 'delayed inherited hold'), [0.2, 0.4, 0, 0]);
  play(delayed, 0.35, () => eyelids(0.21875, 0.55, 'unequal inherited times'), [0.2, 0.4, 0, 0]);

  // One concrete start anchor cannot represent several enabled inherited
  // contributors after a max merge. Reject this previously overwritten shape.
  assert.throws(() => typed([channel(43, 0, 0.3, true), channel(43, 0, 0.7)]), /Overlapping inherited channels for Au\(43\).*morph/);
  assert.throws(() => typed([channel(43, 0, 0.8)], { intensityScale: 0 }), /No runtime tracks could be resolved/);

  // Unequal key times and per-channel gain survive channel normalization.
  play(typed([
    { ...channel(43, -1, 0.8), intensityScale: 0.5 },
    { target: { type: 'au', id: 43, balance: 1 }, keyframes: [{ time: 0, intensity: 0 }, { time: 0.5, intensity: 1 }, { time: 1, intensity: 0 }] },
  ], { intensityScale: 0.5 }), 0.5, () => eyelids(0.1, 0.5, 'times and gains'));
  play(typed([channel(43, -1, 1, true), channel(43, 1, 1, true)], { intensityScale: 0 }), 0.5, () => eyelids(0.4, 0.1, 'zero-gain release'), [0.8, 0.2, 0, 0]);

  // The max envelope needs an extra key at the interior intersection.
  const crossing = typed([
    channel(43, -1, 1),
    { target: { type: 'au', id: 43, balance: -1 }, keyframes: [{ time: 0, intensity: 1 }, { time: 1, intensity: 0 }] },
  ]);
  for (const time of [0.25, 0.5, 0.75]) play(crossing, time, () => eyelids(Math.max(time, 1 - time), 0, 'crossing envelope'));

  // A typed viseme does not reinterpret an AU with the same numeric id.
  play(typed([
    { target: { type: 'au', id: 1 }, keyframes: curve(0.3) },
    { target: { type: 'viseme', id: 1 }, keyframes: curve(0.7) },
  ], { snippetCategory: 'visemeSnippet', autoVisemeJaw: false }), 1, () => {
    near(mesh.morphTargetInfluences[2], 0.3, 'AU namespace');
    near(mesh.morphTargetInfluences[3], 0.7, 'viseme namespace');
  });

  const bones = typed([channel(61, -1, 0.3), channel(61, 1, 0.7)]);
  play(bones, 1, () => {
    near(left.rotation.y, Math.PI / 3 * 0.3, 'left bone');
    near(right.rotation.y, Math.PI / 3 * 0.7, 'right bone');
  });
} finally {
  mixer.stopAllAction(); core.free(); geometry.dispose(); mesh.material.dispose();
}
console.log('Bilateral typed-channel Wasm/Three smoke passed');
