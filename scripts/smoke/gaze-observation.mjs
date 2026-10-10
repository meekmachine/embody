import assert from 'node:assert/strict';
import { Bone, Group, Vector3 } from 'three';
import { ThreeGazeObserver } from '../../dist/three.js';

// CI consumes the built renderer adapter without a browser or playback solver.
// These tests move fixture bones explicitly, then ask whether a read reports
// those actual transforms honestly. They do not ask the observer to aim eyes.
const near = (actual, expected, label, tolerance = 1e-5) =>
  assert(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);
const fixture = () => {
  // Two separated eye origins expose finite-distance convergence error even
  // when both rays are parallel. Custom names require saved role resolution;
  // nonunit sparse optical axes require normalization, not a hardcoded +Z ray.
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
  // A parallel pair misses the finite target by atan(half-separation/distance).
  // The independent analytic angle checks degree units and aggregation; the
  // full local-transform snapshot checks that reading has not corrected pose.
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
  // Only this fixture applies aiming rotations. Once it moves one eye away
  // again, the measured error must increase even though no playback status
  // changed; a finished animation is not evidence of an achieved look goal.
  for (const eye of [rig.left, rig.right]) {
    eye.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(0, 0, 5).sub(eye.position).normalize());
  }
  near(observer.observe(target).angularErrorDeg, 0, 'measured convergence');
  rig.left.rotation.y += 0.2;
  assert(observer.observe(target).angularErrorDeg > 10, 'a finished clip cannot imply a successful look');
}

{
  // Without explicit calibration, CC4's signed rz yaw and negative-rx pitch
  // imply bone-local -Y forward. This case would fail an unconditional +Z
  // assumption even though the synthetic +Z fixture above looked correct.
  const rig = fixture();
  delete rig.profile.gazeCalibration;
  for (const id of [61, 62]) for (const row of rig.profile.auToBones[id]) row.channel = 'rz';
  const result = new ThreeGazeObserver(rig.model, rig.profile).observe({ x: 0, y: -5, z: 0 });
  assert.equal(result.status, 'available');
  assert.deepEqual(result.eyes[0].direction, { x: 0, y: -1, z: 0 }, 'signed CC4 axes infer -Y');
}

for (const clear of ['bindings', 'composites']) {
  // Both forms of authoring removal remain observable. An explicit optical
  // axis cannot revive a cleared AU map or a cleared rotation-composition table.
  // Zero angular error would falsely imply success, so the aggregate is null.
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
  // Preserve a useful one-eye measurement while refusing a binocular result.
  // Replacing a missing eye with the other eye's transform would conceal an
  // incomplete model/profile binding from the consuming agency.
  const rig = fixture();
  rig.head.remove(rig.right);
  const result = new ThreeGazeObserver(rig.model, rig.profile).observe(target);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'missing-eye-bone');
  assert.equal(result.angularErrorDeg, null);
  assert.equal(result.eyes.length, 1, 'retain measured left eye without inventing binocular success');
}

{
  // Full parent matrices matter: nonuniform scale changes a transformed ray,
  // and a matrixAutoUpdate=false parent must retain its manually authored matrix.
  // Cache refresh is allowed, but local TRS values must remain byte-for-byte
  // unchanged. Invalid and coincident targets are absence, not a neutral ray.
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
  // Unknown input stays unknown at the adapter boundary. A present malformed
  // calibration coordinate cannot silently fall back to an inferred optical
  // axis and report a plausible but unsupported measurement.
  const rig = fixture();
  rig.profile.gazeCalibration.leftEye.opticalAxis = { x: 'bad', y: 0, z: 1 };
  const result = new ThreeGazeObserver(rig.model, rig.profile).observe(target);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'unknown-optical-axis');
  assert.equal(result.angularErrorDeg, null);
}

console.log('Read-only gaze observation smoke passed');
