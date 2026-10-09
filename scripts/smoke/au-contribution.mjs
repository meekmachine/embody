import assert from 'node:assert/strict';
import { Bone, BufferGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { captureModelReferencePose, ThreeAuContribution } from '@lovelace_lol/embody/three';
import { initEmbodyCore } from '@lovelace_lol/embody/wasm';

const core = await initEmbodyCore();
const near = (actual, expected, label, tolerance = 1e-5) =>
  assert(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);
const profile = JSON.parse(core.get_preset_json('cc4'));
profile.morphToMesh.eye = ['CC_Base_Body'];
profile.auToMorphs['51'] = { center: ['Turn'], left: [], right: [] };
profile.auToMorphs['61'] = { center: ['Shared'], left: ['Left'], right: ['Right'] };
profile.auToMorphs['62'] = { center: ['Opposite'], left: [], right: [] };
profile.auToBones['51'].push({ node: 'Extra', channel: 'ry', scale: 0.5, maxDegrees: 20 });
profile.auToBones['51'].push({ node: 'Extra', channel: 'tx', scale: 0.5, maxUnits: 0.2 });
profile.compositeRotations.push({ node: 'Extra', yaw: { aus: [51], axis: 'ry' } });
for (const id of [51, 61, 62]) profile.auMixDefaults[id] = 1;

const model = new Group();
const parent = new Object3D(); parent.name = 'UnanimatedParent';
const otherParent = new Object3D(); otherParent.name = 'OtherParent';
const placeholder = new Object3D(); placeholder.name = 'Placeholder'; otherParent.add(placeholder);
const head = new Bone(); head.name = 'CC_Base_Head'; head.position.y = 1;
const extra = new Bone(); extra.name = 'Extra';
const left = new Bone(); left.name = 'CC_Base_L_Eye'; left.position.set(-0.03, 0.1, 0.08); left.rotation.x = -Math.PI / 2;
const right = new Bone(); right.name = 'CC_Base_R_Eye'; right.position.set(0.03, 0.1, 0.08); right.rotation.x = -Math.PI / 2;
head.add(left, right); parent.add(head); model.add(parent, otherParent, extra);
const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial()); mesh.name = 'CC_Base_Body';
mesh.morphTargetDictionary = { Turn: 0, Shared: 1, Left: 2, Right: 3, Opposite: 4 };
mesh.morphTargetInfluences = [0.1, 0.05, 0.02, 0.03, 0.04];
model.add(mesh);
// Bind explicit reference before authored animation changes the current pose.
const referencePose = captureModelReferencePose(model);
const contribution = new ThreeAuContribution(model, profile, { referencePose });
head.rotation.set(0.2, -0.15, 0.07);
parent.rotation.z = 0.3; parent.scale.set(-1.3, 0.8, 1.1);
extra.position.x = 0.4;
const base = head.quaternion.clone();
const eyeBase = left.quaternion.clone();
const before = contribution.readPose();
assert.equal(before.joints.head.name, head.name);
assert.equal(before.joints.head.axes.yaw.negative.auId, 51);
near(before.joints.head.axes.yaw.negative.radians, Math.PI / 3, 'authored head response');
assert.equal(before.joints.leftEye.axes.yaw.negative.side, 'left');
assert.deepEqual(before.joints.leftEye.opticalAxis, [0, -1, 0]);
assert(before.nodes.some((node) => node.id === before.joints.head.nodeId && node.parentId !== before.modelNodeId));
assert(before.nodes.every((node) => node.parentWorldMatrix.length === 16 && node.referenceLocalMatrix.length === 16));
// Manual matrices, including shear, remain authoritative for unchanged parents.
parent.updateMatrix();
parent.matrixAutoUpdate = false;
parent.matrix.elements[4] += 0.12;
const manual = contribution.readPose();
const parentNode = manual.nodes.find((node) => node.name === parent.name);
assert.equal(parentNode.matrixAutoUpdate, false);
assert.deepEqual(parentNode.localMatrix, parent.matrix.toArray());
const headNode = manual.nodes.find((node) => node.name === head.name);
assert.deepEqual(headNode.parentWorldMatrix, parent.matrixWorld.toArray());
assert.deepEqual(headNode.worldMatrix, new Matrix4().multiplyMatrices(parent.matrixWorld, head.matrix).toArray());
// Every object, name and child count survives this swap; parent identity changes.
otherParent.add(head); parent.add(placeholder);
assert.throws(() => contribution.readPose(), /hierarchy changed/);
parent.add(head); otherParent.add(placeholder);

// Separate eyes can use opposite AUs. The same unsigned AU also carries
// independent side amplitudes without clearing the other direction globally.
const samples = [{ id: 51, intensity: 0.5 }, { id: 61, intensity: 0.8, balance: -0.75 },
  { id: 62, intensity: 0.4, balance: 1 }];
const evaluated = contribution.evaluate(samples);
near(head.quaternion.angleTo(base), 0, 'candidate evaluation is read-only');
assert.deepEqual(mesh.morphTargetInfluences, [0.1, 0.05, 0.02, 0.03, 0.04]);
assert(evaluated.bones.some((row) => row.boneId !== before.joints.head.boneId &&
  row.boneId !== before.joints.leftEye.boneId && row.boneId !== before.joints.rightEye.boneId), 'extra AU output is retained');
contribution.apply(samples);
near(head.quaternion.angleTo(base.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 6))), 0, 'authored head base is retained');
near(extra.position.x, 0.45, 'canonical mapped translation preserves its authored base');
near(left.quaternion.angleTo(eyeBase.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 25 * 0.8 * Math.PI / 180))), 0, 'left side retains unsigned command');
near(right.quaternion.angleTo(eyeBase.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -25 * 0.2 * Math.PI / 180))), 0, 'right side combines opposite directions');
for (const [index, value] of [[0, 0.6], [1, 0.85], [2, 0.82], [3, 0.23], [4, 0.44]]) {
  near(mesh.morphTargetInfluences[index], value, `canonical mapped morph ${index}`);
}
const held = head.quaternion.clone();
contribution.apply(samples);
near(head.quaternion.angleTo(held), 0, 'repeat apply never accumulates');
near(mesh.morphTargetInfluences[0], 0.6, 'repeat morph apply never accumulates');
head.matrixAutoUpdate = false;
assert.throws(() => contribution.apply(samples), /manual-matrix bone/);
near(head.quaternion.angleTo(held), 0, 'unsupported bone matrix rejects before scene writes');
near(mesh.morphTargetInfluences[0], 0.6, 'unsupported bone matrix preserves prior morph');
head.matrixAutoUpdate = true;
for (const invalid of [
  [{ id: 51, intensity: 0.1 }, { id: 61, intensity: NaN }],
  [{ id: 51, intensity: -1 }], [{ id: 51, intensity: 0.3, balance: 2 }],
  [{ id: 51, intensity: 0.3 }, { id: 51, intensity: 0.4 }],
  new Array(1),
]) {
  assert.throws(() => contribution.apply(invalid));
  near(head.quaternion.angleTo(held), 0, 'invalid batch preserves prior pose');
  near(mesh.morphTargetInfluences[0], 0.6, 'invalid batch preserves prior morph');
}
assert.throws(() => contribution.rebind(model, 'malformed profile', { referencePose }));
near(head.quaternion.angleTo(held), 0, 'failed rebind preserves contribution');
// Same-model profile replacement retains the original reference automatically.
contribution.rebind(model, profile);
contribution.apply(samples);
near(head.quaternion.angleTo(held), 0, 'same-model rebind never captures the active contribution as neutral');
contribution.apply([]);
near(head.quaternion.angleTo(base), 0, 'empty sample releases to authored base');
near(extra.position.x, 0.4, 'empty sample releases mapped translation to its authored base');
assert.deepEqual(mesh.morphTargetInfluences, [0.1, 0.05, 0.02, 0.03, 0.04]);

contribution.apply(samples);
head.rotation.set(-0.4, 0.2, 0.1);
const external = head.quaternion.clone();
mesh.morphTargetInfluences[0] = 0.72;
contribution.restore();
near(head.quaternion.angleTo(external), 0, 'newer external bone write survives restore');
near(mesh.morphTargetInfluences[0], 0.72, 'newer external morph write survives restore');
const oldRevision = contribution.readPose().bindingRevision;
contribution.rebind(model, {}, { referencePose });
assert.notEqual(contribution.readPose().bindingRevision, oldRevision);
assert.deepEqual(contribution.evaluate(samples).bones, []);
assert.deepEqual(contribution.evaluate(samples).morphs, []);
assert.equal(contribution.readPose().joints.head, null);
contribution.dispose(); contribution.dispose();
assert.throws(() => contribution.readPose(), /disposed/);
assert.throws(() => contribution.apply(samples), /disposed/);
mesh.geometry.dispose(); mesh.material.dispose();
console.log('Semantic AU contribution contract passed');
