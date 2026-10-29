import assert from 'node:assert/strict';
import { AnimationClip, Bone, BufferGeometry, Group, Mesh, MeshBasicMaterial, NumberKeyframeTrack, VectorKeyframeTrack } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createRustEmbodyHost } from '../../dist/three.js';
import { renderHostFrame } from '../test/helpers/render-playback.mjs';

const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-5, `${actual} != ${expected}`);
const snapshot = (clip) => clip.tracks.map((track) => ({ name: track.name, times: Array.from(track.times), values: Array.from(track.values), createInterpolant: track.createInterpolant }));

// Euler values beyond one turn remain scalar angles, including live intensity edits.
{
  const model = new Group();
  const head = new Bone();
  head.name = 'Head';
  const angle = 2 * Math.PI + 0.2;
  head.rotation.set(angle, 0, 0, 'ZYX');
  model.add(head);
  const clip = new AnimationClip('euler', 1, [new VectorKeyframeTrack('Head.rotation', [0, 1], [angle, 0, 0, angle + 0.4, 0, 0])]);
  const original = snapshot(clip);
  const character = await createRustEmbodyHost(model, { profileMode: 'profile', profile: {} });
  try {
    character.registerAnimationClips([clip]);
    const handle = character.playAnimation('euler', { intensityScale: 0.5, loopMode: 'repeat' });
    renderHostFrame(character, 0.5);
    near(head.rotation.x, angle + 0.1);
    assert.equal(head.rotation.order, 'ZYX');
    handle.setIntensity(0);
    renderHostFrame(character, 0);
    near(head.rotation.x, angle);
    handle.stop();
    const indexed = new AnimationClip('indexed-euler', 1, [new NumberKeyframeTrack('Head.rotation[x]', [0, 1], [angle, angle + 0.2])]);
    character.registerAnimationClips([indexed]);
    character.playAnimation(indexed.name);
    renderHostFrame(character, 0.5);
    near(head.rotation.x, angle + 0.1);
    assert.deepEqual(snapshot(clip), original);
  } finally { character.dispose(); }
}

// Packed glTF weights retain individual baselines and share bindings with
// indexed native tracks and generated semantic tracks.
{
  const model = new Group();
  const face = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  face.name = 'PackedFace';
  face.morphTargetDictionary = { Smile: 0, Blink: 1 };
  face.morphTargetInfluences = [0.1, 0.2];
  model.add(face);
  const packed = new AnimationClip('packed', 1, [new NumberKeyframeTrack('PackedFace.morphTargetInfluences', [0, 1], [0.1, 0.2, 0.5, 0.4])]);
  const indexed = new AnimationClip('indexed', 1, [new NumberKeyframeTrack('PackedFace.morphTargetInfluences[Smile]', [0, 1], [0.9, 0.9])]);
  const original = snapshot(packed);
  const profile = { auToMorphs: { 200: { center: ['Smile'], left: [], right: [] } }, morphToMesh: { face: ['PackedFace'] } };
  const character = await createRustEmbodyHost(model, { profileMode: 'profile', profile });
  try {
    character.registerAnimationClips([packed, indexed]);
    const handle = character.playAnimation('packed', { intensityScale: 2, loopMode: 'repeat' });
    renderHostFrame(character, 0.5);
    near(face.morphTargetInfluences[0], 0.5);
    near(face.morphTargetInfluences[1], 0.4);
    handle.setIntensity(0);
    renderHostFrame(character, 0);
    near(face.morphTargetInfluences[0], 0.1);
    near(face.morphTargetInfluences[1], 0.2);
    handle.setIntensity(1);
    renderHostFrame(character, 0);
    character.playAnimation('indexed', { loopMode: 'repeat' });
    renderHostFrame(character, 0);
    near(face.morphTargetInfluences[0], 0.6);
    near(face.morphTargetInfluences[1], 0.3);
    character.playSnippet({ name: 'compiled', curves: { 200: [{ time: 0, intensity: 0.3 }, { time: 1, intensity: 0.3 }] } }, { loopMode: 'repeat' });
    renderHostFrame(character, 0);
    near(face.morphTargetInfluences[0], 0.5);
    assert.deepEqual(snapshot(packed), original);
  } finally { character.dispose(); }
}

// Parse actual multi-key glTF CUBICSPLINE weights, including both morphs' tangents.
{
  const samples = new Float32Array([
    0, 0, 0, // position
    1, 0, 0, // first morph displacement
    0, 1, 0, // second morph displacement
    0, 1, // key times
    0, 0, 0.1, 0.2, 0.2, 0.1, // in tangent, value, out tangent
    0, 0, 0.5, 0.4, 0, 0,
  ]);
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' }, buffers: [{ byteLength: samples.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 12 },
      { buffer: 0, byteOffset: 12, byteLength: 12 },
      { buffer: 0, byteOffset: 24, byteLength: 12 },
      { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 48 },
    ],
    accessors: [
      ...[[0, 0, 0], [1, 0, 0], [0, 1, 0]].map((value, bufferView) => ({ bufferView, componentType: 5126, count: 1, type: 'VEC3', min: value, max: value })),
      { bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 4, componentType: 5126, count: 12, type: 'SCALAR' },
    ],
    meshes: [{ weights: [0.1, 0.2], primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }, { POSITION: 2 }] }] }],
    nodes: [{ name: 'CubicFace', mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
    animations: [{ name: 'cubic-weights', samplers: [{ input: 3, output: 4, interpolation: 'CUBICSPLINE' }], channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }] }],
  }));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const glb = new ArrayBuffer(28 + jsonLength + samples.byteLength);
  const header = new DataView(glb);
  for (const [offset, value] of [[0, 0x46546c67], [4, 2], [8, glb.byteLength], [12, jsonLength], [16, 0x4e4f534a], [20 + jsonLength, samples.byteLength], [24 + jsonLength, 0x004e4942]]) header.setUint32(offset, value, true);
  const bytes = new Uint8Array(glb);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  bytes.set(new Uint8Array(samples.buffer), 28 + jsonLength);
  const asset = await new GLTFLoader().parseAsync(glb, '');
  const face = asset.scene.getObjectByName('CubicFace');
  const clip = asset.animations[0];
  const original = snapshot(clip);
  const character = await createRustEmbodyHost(asset.scene, { profileMode: 'profile', profile: {} });
  try {
    character.registerAnimationClips([clip]);
    const handle = character.playAnimation(clip.name, { loopMode: 'repeat' });
    renderHostFrame(character, 0.5);
    near(face.morphTargetInfluences[0], 0.325);
    near(face.morphTargetInfluences[1], 0.3125);
    handle.setIntensity(2);
    renderHostFrame(character, 0);
    near(face.morphTargetInfluences[0], 0.55);
    near(face.morphTargetInfluences[1], 0.425);
    handle.setIntensity(0);
    renderHostFrame(character, 0);
    near(face.morphTargetInfluences[0], 0.1);
    near(face.morphTargetInfluences[1], 0.2);
    character.setProfile({ morphToMesh: { face: [] } });
    character.playAnimation(clip.name, { loopMode: 'repeat' });
    renderHostFrame(character, 0.5);
    near(face.morphTargetInfluences[0], 0.325);
    near(face.morphTargetInfluences[1], 0.3125);
    assert.deepEqual(snapshot(clip), original);
  } finally { character.dispose(); }
}

console.log('Native Euler and packed morph track compatibility passed');
