import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AnimationClip, AnimationMixer, Bone, Group, Quaternion, QuaternionKeyframeTrack, Vector3 } from 'three';
import { ThreeGazeFocus } from '../../dist/three.js';
import { initEmbodyCore } from '../../dist/wasm.js';

const preset = JSON.parse(await readFile(new URL('../../assets/presets/cc4.json', import.meta.url)));
const radians = (degrees) => degrees * Math.PI / 180;
const near = (actual, expected, label, tolerance = 1e-5) => assert(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);
const rig = (profile = preset) => {
  const model = new Group();
  const neck = new Bone();
  const head = new Bone();
  head.name = 'CC_Base_Head';
  head.position.y = 1.6;
  const left = new Bone();
  const right = new Bone();
  left.name = 'CC_Base_L_Eye'; right.name = 'CC_Base_R_Eye';
  left.position.set(-0.032, 0.1, 0.09); right.position.set(0.032, 0.1, 0.09);
  left.rotation.x = -Math.PI / 2; right.rotation.x = -Math.PI / 2;
  head.add(left, right); neck.add(head); model.add(neck);
  return { model, neck, head, left, right, focus: new ThreeGazeFocus(model, profile) };
};
const request = (test, worldTarget, options = {}) => ({
  worldTarget, target: test.focus.readControlState({ worldTarget }).target,
  eyesEnabled: true, headEnabled: true, ...options,
});
const controls = (value, headYaw = 0, headPitch = 0) => ({ eyeYaw: value.target.x, eyePitch: value.target.y, headYaw, headPitch });
const focused = (diagnostics, label) => {
  assert.equal(diagnostics.eyes.length, 2, `${label} has both eyes`);
  for (const eye of diagnostics.eyes) {
    assert(eye.errorDegrees < 0.01, `${label} ${eye.name}: ${eye.errorDegrees} degrees`);
    assert.equal(eye.limited, false, `${label} is reachable`);
  }
};

// Calibration is authorable in either resolved profiles or preset overrides.
{
  const wasm = await initEmbodyCore();
  const gazeCalibration = { modelUnitsPerMeter: 100, leftEye: { opticalAxis: { x: 0, y: -1, z: 0 } } };
  const merged = JSON.parse(wasm.merge_embedded_preset('cc4', JSON.stringify({ gazeCalibration })));
  assert.deepEqual(merged.gazeCalibration, gazeCalibration);
}

// Exact finite convergence from separate origins, not two parallel eye rays.
{
  const test = rig();
  const value = request(test, { x: 0, y: 1.7, z: 1.4 });
  const result = test.focus.apply(value, controls(value));
  focused(result, 'finite binocular focus');
  assert(result.eyes[0].direction.x > 0);
  assert(result.eyes[1].direction.x < 0);
}

// Neck animation, rotated rest frames and optical calibration all enter the
// current joint-space solve. Repeated ticks must not accumulate corrections.
for (const tilt of [-10, 10]) {
  const test = rig();
  test.neck.rotation.x = radians(tilt);
  const value = request(test, { x: 0.1, y: 1.85, z: 1.8 });
  const baseHead = test.head.quaternion.clone();
  const baseEye = test.left.quaternion.clone();
  for (let i = 0; i < 20; i += 1) {
    test.focus.restore();
    focused(test.focus.apply(value, controls(value)), `neck ${tilt}, tick ${i}`);
  }
  test.focus.restore();
  near(test.head.quaternion.angleTo(baseHead), 0, 'head base restored');
  near(test.left.quaternion.angleTo(baseEye), 0, 'eye base restored');
  near(test.neck.rotation.x, radians(tilt), 'unowned neck untouched');
}
{
  const profile = structuredClone(preset);
  profile.gazeCalibration = { leftEye: { opticalAxis: { x: 0, y: -1, z: 0 } }, rightEye: { opticalAxis: { x: 0, y: -1, z: 0 } } };
  const test = rig(profile);
  test.left.rotation.x += radians(5); test.right.rotation.x -= radians(4);
  const value = request(test, { x: 0, y: 1.7, z: 1.5 });
  focused(test.focus.apply(value, controls(value)), 'independent eye rest offsets');
}

// The same motor bearing continues to focus while the head travels slowly.
{
  const test = rig();
  const value = request(test, { x: 0, y: 1.7 + Math.tan(radians(15)) * 1.5, z: 1.59 });
  const baseHead = test.head.quaternion.clone();
  focused(test.focus.apply(value, { eyeYaw: value.target.x, eyePitch: value.target.y }), 'head follow delay');
  near(test.head.quaternion.angleTo(baseHead), 0, 'absent head controls preserve delay');
  for (const pitch of [0, 0.1, 0.2, 0.3, 0.4, 0.5]) focused(test.focus.apply(value, controls(value, 0, pitch)), `head travel ${pitch}`);
  const eyeBase = test.left.quaternion.clone();
  test.focus.restore();
  const disabled = test.focus.apply({ ...value, eyesEnabled: false }, controls(value));
  assert(disabled.eyes.some((eye) => eye.errorDegrees > 10));
  assert(test.left.quaternion.angleTo(eyeBase) > radians(1));
}

// Intensity constrains actuator contribution, not the shared target bearing.
{
  const test = rig();
  const value = request(test, { x: 0, y: 2.1, z: 1.6 }, { headEnabled: false, eyeIntensity: 0 });
  const base = test.left.quaternion.clone();
  const result = test.focus.apply(value, controls(value));
  near(test.left.quaternion.angleTo(base), 0, 'zero eye intensity');
  assert(result.eyes.every((eye) => eye.limited && eye.errorDegrees > 10));
}

// Head intensity scales the actuator correction from the animated base, not
// the absolute bearing. Zero must preserve a tilted neck/head pose exactly.
for (const intensity of [0, 0.53, 1, 2]) {
  const test = rig();
  test.neck.rotation.x = radians(10);
  test.model.updateMatrixWorld(true);
  const target = test.left.getWorldPosition(new Vector3()).add(test.right.getWorldPosition(new Vector3()))
    .multiplyScalar(0.5).add(new Vector3(0, 0, 2));
  const value = request(test, target, { headIntensity: intensity });
  const base = test.head.quaternion.clone();
  const result = test.focus.apply(value, controls(value));
  focused(result, `posed head intensity ${intensity}`);
  near(test.head.quaternion.angleTo(base), radians(10 * intensity), `head actuator gain ${intensity}`, 1e-4);
}

// A legacy AU pose is already intensity-adjusted. Invert the gain in joint
// space against the separately evaluated base before seeding new controls.
for (const neckTilt of [0, 10]) {
  const test = rig();
  test.neck.rotation.x = radians(neckTilt);
  const base = test.head.quaternion.clone();
  test.head.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), radians(18)))
    .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), radians(-4)));
  const actual = test.head.quaternion.clone();
  test.model.updateMatrixWorld(true);
  const worldTarget = test.left.getWorldPosition(new Vector3()).add(test.right.getWorldPosition(new Vector3())).multiplyScalar(0.5)
    .add(new Vector3(0, 0, 2).applyQuaternion(test.head.getWorldQuaternion(new Quaternion())));
  const options = { worldTarget, headIntensity: 0.53, headBaseQuaternion: { x: base.x, y: base.y, z: base.z, w: base.w } };
  const seed = test.focus.readControlState(options);
  assert.equal(seed.headSeedLimited, false, 'legacy pose has a representable inverse-gain seed');
  near(test.head.quaternion.angleTo(actual), 0, 'reading the inverse seed is pure');
  test.head.quaternion.copy(base);
  const value = request(test, worldTarget, { headIntensity: 0.53 });
  test.focus.apply(value, { eyeYaw: seed.eyeTarget.x, eyePitch: seed.eyeTarget.y, headYaw: seed.headTarget.x, headPitch: seed.headTarget.y });
  near(test.head.quaternion.angleTo(actual), 0, `gain handoff with neck ${neckTilt}`, 1e-4);
  test.focus.restore();
  test.head.quaternion.copy(actual);
  assert.equal(test.focus.readControlState({ ...options, headIntensity: 0 }).headSeedLimited, true, 'zero gain reports an unrepresentable legacy excursion');
}

// Limits follow the signed bindings independently on each eye and direction.
{
  const profile = structuredClone(preset);
  for (const binding of profile.auToBones[63]) binding.maxDegrees = binding.side === 'left' ? 5 : 12;
  const test = rig(profile);
  const value = request(test, { x: 0, y: 1.7 + Math.tan(radians(15)) * 1.5, z: 1.59 }, { headEnabled: false });
  const result = test.focus.apply(value, controls(value));
  assert(result.eyes.every((eye) => eye.limited));
  assert(result.eyes[0].errorDegrees > result.eyes[1].errorDegrees + 5);
}

// Scaling/rotating/translating the whole scene keeps the same finite focus.
for (const scale of [0.1, 1, 10]) {
  const test = rig();
  test.model.scale.setScalar(scale);
  test.model.rotation.set(0.15, 0.4, -0.1);
  test.model.position.set(2, -1, 3);
  test.model.updateMatrixWorld(true);
  const target = test.model.localToWorld(new Vector3(0.2, 1.8, 1.7));
  const value = request(test, target);
  focused(test.focus.apply(value, controls(value)), `transformed scene ${scale}`);
}

// A noncanonical head basis still uses the profile's actual signed channels.
{
  const profile = structuredClone(preset);
  for (const id of [51, 52]) profile.auToBones[id][0].channel = 'rz';
  const test = rig(profile);
  test.head.rotation.x = -Math.PI / 2;
  test.left.quaternion.identity(); test.right.quaternion.identity();
  const value = request(test, { x: 0.2, y: 1.75, z: 1.7 });
  focused(test.focus.apply(value, controls(value)), 'noncanonical joint frame');
}

// A missing/uncalibrated eye stays absent; the other eye continues to work.
{
  const test = rig();
  test.head.remove(test.right);
  test.focus = new ThreeGazeFocus(test.model, preset);
  const value = request(test, { x: 0, y: 1.7, z: 1.6 });
  const result = test.focus.apply(value, controls(value));
  assert.equal(result.missingEyes, true);
  assert.equal(result.eyes.length, 1);
  assert(result.eyes[0].errorDegrees < 0.01);
}

// A newer pose write supersedes the helper's overlay and must survive restore.
{
  const test = rig();
  const value = request(test, { x: 0.1, y: 1.9, z: 1.6 });
  test.focus.apply(value, controls(value));
  test.head.rotation.x = 0.3;
  const newer = test.head.quaternion.clone();
  test.focus.restore();
  near(test.head.quaternion.angleTo(newer), 0, 'newer authored head survives restore');
  focused(test.focus.apply(value, controls(value)), 'newly authored base');
  test.focus.restore();
  near(test.head.quaternion.angleTo(newer), 0, 'newer authored head becomes next base');
}

// A constant mixer frame may not rewrite its property. Restoring the previous
// base before every evaluation keeps it distinct from the constraint output.
{
  const test = rig();
  const base = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), radians(8));
  const clip = new AnimationClip('constant head', 1, [new QuaternionKeyframeTrack(`${test.head.name}.quaternion`, [0, 1], [...base.toArray(), ...base.toArray()])]);
  const mixer = new AnimationMixer(test.model);
  mixer.clipAction(clip).play();
  const value = request(test, { x: 0, y: 1.7, z: 1.5 });
  for (let i = 0; i < 15; i += 1) {
    test.focus.restore(); mixer.update(0.016);
    focused(test.focus.apply(value, controls(value)), 'constant mixer base');
    test.focus.restore(); near(test.head.quaternion.angleTo(base), 0, 'mixer pose retained');
  }
  mixer.stopAllAction();
}

console.log('Rig-aware gaze focus smoke passed');
