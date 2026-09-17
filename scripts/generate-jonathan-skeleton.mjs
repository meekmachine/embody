#!/usr/bin/env node

// One-off generator for the reviewed Jonathan asset, not a general GLB extractor.
// See assets/templates/README.md for the coordinate and rest-pose contract.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Bone, Group, Matrix4, Object3D } from 'three';

const SOURCE_SHA256 = '0619c8b5e1589823e583c80e24d3f4567cdbc3349907a1569577585cbfdde192';
const outputPath = fileURLToPath(new URL('../assets/templates/cc4-humanoid.json', import.meta.url));
const [inputPath, mode] = process.argv.slice(2);
assert(inputPath && (!mode || mode === '--check') && process.argv.length <= 4,
  'Usage: node scripts/generate-jonathan-skeleton.mjs <jonathan_new.glb> [--check]');
const source = readFileSync(inputPath);
assert.equal(createHash('sha256').update(source).digest('hex'), SOURCE_SHA256,
  'This one-off generator only supports the reviewed Jonathan GLB; review a changed source first.');
assert.equal(source.toString('utf8', 0, 4), 'glTF');
assert.equal(source.readUInt32LE(4), 2);
assert.equal(source.readUInt32LE(8), source.length);
let json;
let binary;
for (let offset = 12; offset < source.length;) {
  const length = source.readUInt32LE(offset);
  const type = source.readUInt32LE(offset + 4);
  const data = source.subarray(offset + 8, offset + 8 + length);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
  if (type === 0x004e4942) binary = data;
  offset += 8 + length;
}
assert(json && binary);
const skin = json.skins.find((candidate) => candidate.name === 'Armature');
assert.equal(skin?.joints.length, 101);
const joints = new Set(skin.joints);
const parents = new Map();
json.nodes.forEach((node, index) => (node.children ?? []).forEach((child) => parents.set(child, index)));
const rootIndex = skin.joints.find((index) => json.nodes[index].name === 'CC_Base_BoneRoot');
const armatureIndex = parents.get(rootIndex);
const armature = json.nodes[armatureIndex];
assert.equal(armature.name, 'Armature');
assert.deepEqual(json.scenes[json.scene].nodes, [armatureIndex]);
assert.equal(parents.has(armatureIndex), false);
assert.equal(armature.matrix, undefined);
assert.deepEqual(armature.translation ?? [0, 0, 0], [0, 0, 0]);
assert.deepEqual(armature.rotation ?? [0, 0, 0, 1], [0, 0, 0, 1]);
assert.deepEqual(armature.scale, Array(3).fill(0.009999999776482582));

// Evaluate the authored default node pose; never play the Calibration clips.
const sourceNodes = json.nodes.map((node) => {
  assert.equal(node.matrix, undefined, 'Reviewed source uses node TRS');
  const object = new Object3D();
  object.name = node.name;
  object.position.fromArray(node.translation ?? [0, 0, 0]);
  object.quaternion.fromArray(node.rotation ?? [0, 0, 0, 1]);
  object.scale.fromArray(node.scale ?? [1, 1, 1]);
  return object;
});
for (const [child, parent] of parents) sourceNodes[parent].add(sourceNodes[child]);
sourceNodes[armatureIndex].updateMatrixWorld(true);

const template = {
  id: 'cc4-humanoid',
  sourceCharacterId: 'cc4',
  sourceAsset: 'LoomLarge/frontend/public/characters/jonathan_new.glb',
  sourceSkinName: 'Armature',
  bones: skin.joints.map((index) => {
    const node = json.nodes[index];
    const parentIndex = parents.get(index);
    assert(index === rootIndex || joints.has(parentIndex), 'No intermediate non-joint ancestors expected');
    const root = index === rootIndex;
    return {
      name: node.name,
      parent: root ? null : json.nodes[parentIndex].name,
      translation: (node.translation ?? [0, 0, 0]).map((v, axis) => root ? v * armature.scale[axis] : v),
      rotation: node.rotation ?? [0, 0, 0, 1],
      scale: (node.scale ?? [1, 1, 1]).map((v, axis) => root ? v * armature.scale[axis] : v),
    };
  }),
};
assert.equal(new Set(template.bones.map((bone) => bone.name)).size, 101);

// Independently reconstruct the serialized file through Three's scene graph.
const serialized = `${JSON.stringify(template, null, 2)}\n`;
const roundTrip = JSON.parse(serialized);
const reconstructed = new Map(roundTrip.bones.map((bone) => {
  const result = new Bone();
  result.position.fromArray(bone.translation);
  result.quaternion.fromArray(bone.rotation);
  result.scale.fromArray(bone.scale);
  return [bone.name, result];
}));
const group = new Group();
for (const bone of roundTrip.bones) {
  (bone.parent ? reconstructed.get(bone.parent) : group).add(reconstructed.get(bone.name));
}
group.updateMatrixWorld(true);

// This asset's inverse bind matrices are in glTF scene coordinates. Check once
// that the chosen default node pose agrees with that independently stored pose.
const accessor = json.accessors[skin.inverseBindMatrices];
assert.equal(accessor.type, 'MAT4');
assert.equal(accessor.componentType, 5126);
assert.equal(accessor.count, 101);
assert.equal(accessor.sparse, undefined);
const view = json.bufferViews[accessor.bufferView];
assert.equal(view.buffer, 0);
let maxRoundTripError = 0;
let maxBindPoseError = 0;
const landmarks = {};
const landmarkNames = new Set(['CC_Base_Hip', 'CC_Base_L_Foot', 'CC_Base_R_Foot', 'CC_Base_L_Hand', 'CC_Base_R_Hand', 'CC_Base_Head']);
skin.joints.forEach((index, jointIndex) => {
  const name = json.nodes[index].name;
  const sourceMatrix = sourceNodes[index].matrixWorld;
  const result = reconstructed.get(name).matrixWorld;
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + jointIndex * (view.byteStride ?? 64);
  const bindMatrix = new Matrix4().fromArray(Array.from({ length: 16 }, (_, element) =>
    binary.readFloatLE(byteOffset + element * 4))).invert();
  sourceMatrix.elements.forEach((value, element) => {
    maxRoundTripError = Math.max(maxRoundTripError, Math.abs(value - result.elements[element]));
    maxBindPoseError = Math.max(maxBindPoseError, Math.abs(value - bindMatrix.elements[element]));
  });
  if (landmarkNames.has(name)) landmarks[name] = result.elements.slice(12, 15);
});
assert(maxRoundTripError < 1e-12, `Round-trip matrix error ${maxRoundTripError} exceeds 1e-12`);
assert(maxBindPoseError < 1e-6, `Source default/bind pose error ${maxBindPoseError} exceeds 1e-6`);
assert.equal(Object.keys(landmarks).length, landmarkNames.size);
if (mode === '--check') {
  assert.equal(readFileSync(outputPath, 'utf8'), serialized, 'Checked-in skeleton differs from reviewed source');
} else {
  writeFileSync(outputPath, serialized);
}
console.log(JSON.stringify({ mode: mode ?? 'generate', outputPath, sourceSha256: SOURCE_SHA256, bones: 101,
  maxRoundTripError, maxBindPoseError, landmarks }, null, 2));
