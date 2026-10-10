import assert from 'node:assert/strict';
import { Bone, Group, Vector3 } from 'three';
import { ThreeGazeObserver } from '../../dist/three.js';

const near = (actual, expected, label, tolerance = 1e-5) =>
  assert(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);
const fixture = () => {
  const model = new Group();
  const head = new Bone();
  const left = new Bone();
  const right = new Bone();
  left.name = 'CustomLeft'; right.name = 'CustomRight';
  left.position.x = -0.03; right.position.x = 0.03;
  head.add(left, right); model.add(head);
  const profile = {
    boneNodes: { EYE_L: left.name, EYE_R: right.name },
    auToBones: Object.fromEntries([[61, 'ry', 1], [62, 'ry', -1], [63, 'rx', -1], [64, 'rx', 1]]
      .map(([id, channel, scale]) => [id, ['EYE_L', 'EYE_R'].map(node => ({ node, channel, scale, maxDegrees: 25 }))])),
    compositeRotations: ['EYE_L', 'EYE_R'].map(node => ({ node,
      yaw: { negative: 62, positive: 61 }, pitch: { negative: 64, positive: 63 } })),
    gazeCalibration: { leftEye: { opticalAxis: { z: 2 } }, rightEye: { opticalAxis: { z: 3 } } },
  };
  return { model, head, left, right, profile };
};
const pose = ({ model, head, left, right }) => [model, head, left, right]
  .map(object => [...object.position.toArray(), ...object.quaternion.toArray(), ...object.scale.toArray()]);
const target = { x: 0, y: 0, z: 5 };

{
  const rig = fixture();
  const observer = new ThreeGazeObserver(rig.model, rig.profile);
  const before = pose(rig);
  const result = observer.observe(target);
  assert.equal(result.status, 'available');
  assert.equal(result.reason, null);
  near(result.angularErrorDeg, Math.atan(0.03 / 5) * 180 / Math.PI, 'binocular error');
  assert.deepEqual(result.eyes.map(eye => eye.name), ['CustomLeft', 'CustomRight']);
  assert.deepEqual(result.eyes[0].direction, { x: 0, y: 0, z: 1 });
  assert.deepEqual(pose(rig), before, 'observation preserves every authored transform');
  for (const eye of [rig.left, rig.right]) {
    eye.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(0, 0, 5).sub(eye.position).normalize());
  }
  near(observer.observe(target).angularErrorDeg, 0, 'measured convergence');
  rig.left.rotation.y += 0.2;
  assert(observer.observe(target).angularErrorDeg > 10, 'a finished clip cannot imply a successful look');
}

{
  const rig = fixture();
  delete rig.profile.gazeCalibration;
  for (const id of [61, 62]) for (const row of rig.profile.auToBones[id]) row.channel = 'rz';
  const result = new ThreeGazeObserver(rig.model, rig.profile).observe({ x: 0, y: -5, z: 0 });
  assert.equal(result.status, 'available');
  assert.deepEqual(result.eyes[0].direction, { x: 0, y: -1, z: 0 }, 'signed CC4 axes infer -Y');
}

for (const clear of ['bindings', 'composites']) {
  const rig = fixture();
  if (clear === 'bindings') rig.profile.auToBones = {};
  else rig.profile.compositeRotations = [];
  const result = new ThreeGazeObserver(rig.model, rig.profile).observe(target);
  assert.equal(result.status, 'unavailable', `${clear} cannot claim a mapped gaze`);
  assert.equal(result.reason, 'missing-eye-mapping');
  assert.equal(result.angularErrorDeg, null);
  assert.deepEqual(result.eyes, []);
}

{
  const rig = fixture();
  rig.head.remove(rig.right);
  const result = new ThreeGazeObserver(rig.model, rig.profile).observe(target);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'missing-eye-bone');
  assert.equal(result.angularErrorDeg, null);
  assert.equal(result.eyes.length, 1, 'retain measured left eye without inventing binocular success');
}

{
  const rig = fixture();
  rig.model.scale.set(2, 3, 0.5);
  rig.head.rotation.y = 0.2;
  rig.head.updateMatrix();
  rig.head.matrixAutoUpdate = false;
  const before = pose(rig);
  const observer = new ThreeGazeObserver(rig.model, rig.profile);
  const result = observer.observe(target);
  const expected = new Vector3(0, 0, 1).transformDirection(rig.left.matrixWorld);
  near(result.eyes[0].direction.x, expected.x, 'full ancestor matrix direction');
  near(result.eyes[0].direction.z, expected.z, 'full ancestor matrix direction');
  assert.deepEqual(pose(rig), before, 'manual parent and nonuniform scale are observation-only');
  assert.equal(observer.observe({ x: NaN, y: 0, z: 1 }).reason, 'invalid-target');
  assert.equal(observer.observe(result.eyes[0].origin).reason, 'coincident-target');
}

{
  const rig = fixture();
  rig.profile.gazeCalibration.leftEye.opticalAxis = { x: 'bad', y: 0, z: 1 };
  const result = new ThreeGazeObserver(rig.model, rig.profile).observe(target);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'unknown-optical-axis');
  assert.equal(result.angularErrorDeg, null);
}

console.log('Read-only gaze observation smoke passed');
