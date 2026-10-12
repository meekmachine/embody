import assert from 'node:assert/strict';
import { AnimationMixer, Bone, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { ThreeGazeObserver, ThreeModelInspector, captureModelReferencePose, createAnimationClipFromClipIR } from '../../dist/three.js';
import { initEmbodyCore } from '../../dist/wasm.js';

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

const calibratedFixture = () => {
  const rig = fixture();
  rig.head.name = 'CustomHead';
  rig.profile.boneNodes.HEAD = rig.head.name;
  for (const rows of Object.values(rig.profile.auToBones)) {
    for (const row of rows) row.side = row.node === 'EYE_L' ? 'left' : 'right';
  }
  for (const [id, channel, maxDegrees] of [[51, 'ry', 55], [52, 'ry', -35], [53, 'rx', -30],
    [54, 'rx', 20], [55, 'rz', -15], [56, 'rz', 25]]) {
    rig.profile.auToBones[id] = [{ node: 'HEAD', channel, maxDegrees }];
  }
  rig.profile.compositeRotations.unshift({ node: 'HEAD',
    yaw: { negative: 55, positive: 56 }, pitch: { negative: 54, positive: 53 },
    roll: { negative: 52, positive: 51 } });
  rig.model.position.set(2, 3, 4);
  rig.model.scale.set(2, 3, 0.5);
  rig.head.position.set(0.1, 1, 0.2);
  rig.head.rotation.set(0.2, 0.3, -0.1);
  const parent = new Group();
  parent.position.set(0.03, 0.05, 0.08);
  parent.rotation.z = 0.2;
  parent.scale.set(1.2, 0.9, 1.1);
  parent.updateMatrix(); parent.matrixAutoUpdate = false;
  parent.add(rig.left, rig.right); rig.head.add(parent);
  rig.left.rotation.y = 0.05; rig.right.rotation.x = 0.1;
  rig.profile.gazeCalibration.leftEye.opticalAxis = { x: 0.1, z: 0.4 };
  return { ...rig, parent };
};
const wasm = await initEmbodyCore();
const matrixNear = (actual, expected, label) => actual.forEach((value, index) => near(value, expected[index], `${label}/${index}`));

{
  const rig = calibratedFixture();
  const referencePose = captureModelReferencePose(rig.model);
  const observer = new ThreeGazeObserver(rig.model, rig.profile, { referencePose });
  const before = pose(rig);
  const geometry = observer.getRigGeometry();
  assert.equal(geometry.status, 'available');
  assert.deepEqual(pose(rig), before);
  assert.deepEqual(geometry.head.referencePosition, [0.1, 1, 0.2]);
  assert(geometry.head.axes.roll.positive.order < geometry.head.axes.yaw.negative.order,
    'response order follows the custom compiler slots');
  rig.model.updateWorldMatrix(true, true);
  const inverseModel = rig.model.matrixWorld.clone().invert();
  for (const [index, eye] of [rig.left, rig.right].entries()) {
    const neutralInModel = new Matrix4().multiplyMatrices(inverseModel, eye.matrixWorld);
    matrixNear(geometry.eyes[index].originInModel, new Vector3().setFromMatrixPosition(neutralInModel).toArray(), 'actual reference eye origin');
    matrixNear(geometry.eyes[index].parentInHeadMatrix, rig.parent.matrix.toArray(), 'manual intermediate parent');
  }
  rig.head.rotation.y += 0.8; rig.left.rotation.x += 0.5;
  assert.deepEqual(observer.getRigGeometry(), geometry, 'animated joints never become the reference');
  geometry.head.referencePosition[0] = 999;
  assert.equal(observer.getRigGeometry().head.referencePosition[0], 0.1, 'facts are detached');
  rig.model.position.x = 7;
  near(observer.getRigGeometry().modelWorldMatrix[12], 7, 'model placement remains current');
}

{
  const rig = calibratedFixture();
  const referencePose = captureModelReferencePose(rig.model);
  const observer = new ThreeGazeObserver(rig.model, rig.profile, { referencePose });
  const geometry = observer.getRigGeometry();
  const inspection = new ThreeModelInspector().inspectModel(rig.model, { profile: rig.profile, referencePose });
  const core = new wasm.RuntimeCore(0);
  core.configure_with_profile(JSON.stringify(rig.profile), JSON.stringify(inspection.descriptor));
  const samples = [{ id: 51, intensity: 0.4 }, { id: 53, intensity: 0.3 }, { id: 56, intensity: 0.2 },
    { id: 61, intensity: 0.6, balance: -1 }, { id: 62, intensity: 0.4, balance: 1 }, { id: 63, intensity: 0.2 }];
  const channels = samples.map(({ id, intensity, balance = 0 }) => ({ target: { type: 'au', id, balance },
    keyframes: [{ time: 0, intensity }, { time: 1, intensity }] }));
  const ir = JSON.parse(core.build_typed_clip('calibrated-rays', JSON.stringify(channels), '{}'));
  const mixer = new AnimationMixer(rig.model);
  mixer.clipAction(createAnimationClipFromClipIR(ir, inspection)).play();
  mixer.update(0.5);
  const local = joint => {
    const rotation = new Quaternion().fromArray(joint.referenceQuaternion);
    const responses = Object.values(joint.axes).flatMap(axis => [axis.negative, axis.positive])
      .filter(Boolean).sort((a, b) => a.order - b.order);
    for (const response of responses) {
      const sample = samples.find(value => value.id === response.auId);
      if (!sample) continue;
      const balance = sample.balance ?? 0;
      const sideScale = response.side === 'left' ? 1 - Math.max(0, balance)
        : response.side === 'right' ? 1 + Math.min(0, balance) : 1;
      rotation.multiply(new Quaternion().setFromAxisAngle(new Vector3(...response.axis),
        response.radians * sample.intensity * sideScale));
    }
    return new Matrix4().compose(new Vector3(...joint.referencePosition), rotation, new Vector3(...joint.referenceScale));
  };
  const headWorld = new Matrix4().fromArray(geometry.modelWorldMatrix)
    .multiply(new Matrix4().fromArray(geometry.head.parentInModelMatrix)).multiply(local(geometry.head));
  const observed = observer.observe({ x: 3, y: 7, z: 5 });
  assert.equal(observed.status, 'available');
  for (const [index, eye] of geometry.eyes.entries()) {
    const predicted = headWorld.clone().multiply(new Matrix4().fromArray(eye.parentInHeadMatrix)).multiply(local(eye));
    const origin = new Vector3().setFromMatrixPosition(predicted);
    const direction = new Vector3(...eye.opticalAxis).transformDirection(predicted);
    matrixNear(Object.values(observed.eyes[index].origin), origin.toArray(), 'compiler endpoint eye pivot');
    matrixNear(Object.values(observed.eyes[index].direction), direction.toArray(), 'compiler endpoint calibrated optical ray');
  }
  core.free(); mixer.stopAllAction();
}

for (const failure of ['missing-reference', 'missing-eye', 'cleared', 'outside-head', 'unsided', 'translated-eye', 'extra-ancestor', 'manual-joint']) {
  const rig = calibratedFixture();
  if (failure === 'missing-eye') rig.parent.remove(rig.right);
  if (failure === 'cleared') rig.profile.compositeRotations = [];
  if (failure === 'outside-head') rig.model.add(rig.right);
  if (failure === 'unsided') delete rig.profile.auToBones[61][0].side;
  if (failure === 'translated-eye') rig.profile.auToBones[61].push({ node: 'EYE_L', channel: 'tx', maxUnits: 0.1 });
  if (failure === 'manual-joint') { rig.left.updateMatrix(); rig.left.matrixAutoUpdate = false; }
  if (failure === 'extra-ancestor') {
    const ancestor = new Bone(); ancestor.name = 'ExtraAncestor';
    rig.model.add(ancestor); ancestor.add(rig.head);
    rig.profile.auToBones[51].push({ node: ancestor.name, channel: 'ry', maxDegrees: 5 });
    rig.profile.compositeRotations.push({ node: ancestor.name, yaw: { aus: [51] } });
  }
  const options = failure === 'missing-reference' ? {} : { referencePose: captureModelReferencePose(rig.model) };
  const result = new ThreeGazeObserver(rig.model, rig.profile, options).getRigGeometry();
  assert.equal(result.status, 'unavailable', failure);
  const reason = { 'missing-reference': 'missing-reference-pose', 'missing-eye': 'missing-eye-bone',
    cleared: 'missing-eye-mapping', 'outside-head': 'eye-outside-head-hierarchy',
    'manual-joint': 'unsupported-joint-transform' }[failure] ?? 'unsupported-chain-mapping';
  assert.equal(result.reason, reason, failure);
}

assert.throws(() => wasm.resolve_profile_gaze_rig_json('bad-json', '{}'));
assert.throws(() => wasm.resolve_profile_gaze_rig_json('{}', 'bad-json'));
console.log('Read-only gaze observation smoke passed');
