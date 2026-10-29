import assert from 'node:assert/strict';
import { Bone, Box3, Group, Vector3 } from 'three';
import { CC4_HUMANOID_SKELETON_TEMPLATE, initEmbodyCore } from '@lovelace_lol/embody/wasm';

const core = await initEmbodyCore();
const template = CC4_HUMANOID_SKELETON_TEMPLATE;
assert.equal(template.bones.length, 101);
assert.deepEqual(JSON.parse(core.get_humanoid_skeleton_template_json(template.id)), template);
assert.deepEqual(JSON.parse(core.list_humanoid_skeleton_templates_json()), [template]);

const bones = new Map(template.bones.map((entry) => {
  assert.equal(entry.rotation.length, 4);
  assert.equal(entry.scale.length, 3);
  const bone = new Bone();
  bone.position.fromArray(entry.translation);
  bone.quaternion.fromArray(entry.rotation);
  bone.scale.fromArray(entry.scale);
  return [entry.name, bone];
}));
const scene = new Group();
for (const entry of template.bones) {
  (entry.parent ? bones.get(entry.parent) : scene).add(bones.get(entry.name));
}
scene.updateMatrixWorld(true);
const bounds = new Box3();
for (const bone of bones.values()) bounds.expandByPoint(new Vector3().setFromMatrixPosition(bone.matrixWorld));
const expected = [...bounds.min.toArray(), ...bounds.max.toArray()];
for (const input of ['', JSON.stringify(template)]) {
  const result = Array.from(core.compute_humanoid_skeleton_template_rest_bounds(input));
  result.forEach((value, axis) => assert(Math.abs(value - expected[axis]) < 1e-12,
    `Wasm bounds differ from Three.js at axis ${axis}: ${value} vs ${expected[axis]}`));
}
const hands = ['CC_Base_L_Hand', 'CC_Base_R_Hand'].map((name) => new Vector3().setFromMatrixPosition(bones.get(name).matrixWorld));
assert(Math.abs(hands[0].distanceTo(hands[1]) - 0.9170457253520947) < 1e-12);
assert(Math.abs(bounds.max.y - 1.726530169334735) < 1e-12);
console.log('Humanoid template package: 101 complete transforms, matching JS/Wasm data and composed bounds.');
