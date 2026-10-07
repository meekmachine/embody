import {
  AdditiveAnimationBlendMode, AnimationClip, AnimationMixer, Bone, BufferGeometry, Group, InterpolateDiscrete,
  MeshBasicMaterial, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, VectorKeyframeTrack,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { expect, it, vi } from 'vitest';
import { captureModelReferencePose } from '../reference-pose';
import {
  convertMixamoToVrmAnimation, convertMixamoFbxToVrmAnimations,
  createAnimationClipFromVrmAnimation, inspectVrmAnimation,
} from '../vrm-animation';

const layout: Array<[string, string, string | null, [number, number, number]]> = [
  ['hips', 'Hips', null, [0, 100, 0]], ['spine', 'Spine', 'hips', [0, 20, 0]], ['head', 'Head', 'spine', [0, 40, 0]],
  ['leftUpperArm', 'LeftArm', 'spine', [20, 20, 0]], ['leftLowerArm', 'LeftForeArm', 'leftUpperArm', [30, 0, 0]], ['leftHand', 'LeftHand', 'leftLowerArm', [25, 0, 0]],
  ['rightUpperArm', 'RightArm', 'spine', [-20, 20, 0]], ['rightLowerArm', 'RightForeArm', 'rightUpperArm', [-30, 0, 0]], ['rightHand', 'RightHand', 'rightLowerArm', [-25, 0, 0]],
  ['leftUpperLeg', 'LeftUpLeg', 'hips', [10, 0, 0]], ['leftLowerLeg', 'LeftLeg', 'leftUpperLeg', [0, -45, 0]], ['leftFoot', 'LeftFoot', 'leftLowerLeg', [0, -45, 0]],
  ['rightUpperLeg', 'RightUpLeg', 'hips', [-10, 0, 0]], ['rightLowerLeg', 'RightLeg', 'rightUpperLeg', [0, -45, 0]], ['rightFoot', 'RightFoot', 'rightLowerLeg', [0, -45, 0]],
];
function fixture(withSkin = false) {
  const model = new Group(); const bones: Record<string, Bone> = {}; const humanoidBones: Record<string, string> = {};
  for (const [role, suffix, parent, position] of layout) {
    const bone = new Bone(); bone.name = `mixamorig${suffix}`; bone.position.fromArray(position);
    (parent ? bones[parent] : model).add(bone); bones[role] = bone; humanoidBones[role] = bone.name;
  }
  model.updateMatrixWorld(true);
  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  if (withSkin) { model.add(mesh); mesh.bind(new Skeleton(Object.values(bones))); }
  const clip = new AnimationClip('Raised arm', 1, [
    new QuaternionKeyframeTrack('mixamorigLeftArm.quaternion', [0, 1], [0, 0, Math.SQRT1_2, Math.SQRT1_2, 0, 0, 1, 0], InterpolateDiscrete),
    new VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 100, 0, 20, 110, 0]),
  ]);
  model.animations = [clip];
  return { model, bones, humanoidBones, clip, mesh };
}

it('exports interoperable GLB and keeps a raised first frame, step keys and centimeters', async () => {
  const { model, clip } = fixture();
  const bytes = convertMixamoToVrmAnimation(model, clip, { metersPerUnit: 0.01, referencePose: captureModelReferencePose(model) });
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('glTF');
  const document = inspectVrmAnimation(bytes);
  expect(document.name).toBe('Raised arm'); expect(document.durationSeconds).toBe(1);
  expect(document.tracks[0].interpolation).toBe('STEP');
  expect(document.tracks[0].values[2]).toBeCloseTo(Math.SQRT1_2);
  expect(document.tracks[1].values[4]).toBeCloseTo(1.1);
  const gltf = await new GLTFLoader().parseAsync(bytes.slice().buffer as ArrayBuffer, '');
  expect(gltf.animations).toHaveLength(1);
  expect(gltf.animations[0].tracks[0].getInterpolation()).toBe(InterpolateDiscrete);
  expect(gltf.userData.gltfExtensions.VRMC_vrm_animation.specVersion).toBe('1.0');
});

it('uses skin bind inverses after source playback instead of recapturing an animated pose', () => {
  const { model, bones, clip } = fixture(true);
  bones.leftUpperArm.rotation.z = -0.7;
  const before = bones.leftUpperArm.quaternion.clone();
  const bytes = convertMixamoToVrmAnimation(model, clip, { metersPerUnit: 0.01 });
  expect(inspectVrmAnimation(bytes).tracks[0].values[2]).toBeCloseTo(Math.SQRT1_2);
  expect(bones.leftUpperArm.quaternion.equals(before)).toBe(true);
});

it('retargets and samples with the host mixer while retaining the captured target reference', () => {
  const source = fixture(); const target = fixture();
  const bytes = convertMixamoToVrmAnimation(source.model, source.clip, { metersPerUnit: 0.01, referencePose: captureModelReferencePose(source.model) });
  for (const bone of Object.values(target.bones)) bone.position.multiplyScalar(2);
  const referencePose = captureModelReferencePose(target.model);
  target.bones.leftUpperArm.rotation.z = -0.5;
  // Host scene placement must not become part of the portable motion.
  target.model.position.set(10, 30, -50); target.model.rotation.y = Math.PI;
  const clip = createAnimationClipFromVrmAnimation(bytes, target.model, { metersPerUnit: 0.01, humanoidBones: target.humanoidBones, referencePose });
  expect(clip.tracks[0].name).toBe(`${target.bones.leftUpperArm.uuid}.quaternion`);
  expect(target.bones.leftUpperArm.rotation.z).toBeCloseTo(-0.5);
  const mixer = new AnimationMixer(target.model); mixer.clipAction(clip).play(); mixer.update(0.5);
  expect(target.bones.leftUpperArm.quaternion.z).toBeCloseTo(Math.SQRT1_2);
  expect(target.bones.hips.position.x).toBeCloseTo(20); expect(target.bones.hips.position.y).toBeCloseTo(210);
  mixer.stopAllAction(); mixer.uncacheRoot(target.model);
});

it('uses profile humanoid roles through the existing Rust characterization resolver', () => {
  const source = fixture();
  const bytes = convertMixamoToVrmAnimation(source.model, source.clip, { metersPerUnit: 0.01, referencePose: captureModelReferencePose(source.model) });
  const profile = { boneNodes: source.humanoidBones, humanoidCharacterization: {
    schemaVersion: 1, standard: 'VRMC_vrm-1.0', status: 'characterized',
    roles: Object.fromEntries(Object.keys(source.humanoidBones).map((role) => [role, { nodeKey: role }])),
  } };
  const clip = createAnimationClipFromVrmAnimation(bytes, source.model, { metersPerUnit: 0.01, referencePose: captureModelReferencePose(source.model), profile });
  expect(clip.tracks[0].name).toBe(`${source.bones.leftUpperArm.uuid}.quaternion`);
});

it('rejects missing references, duplicate mappings, animated scale and malformed binaries', () => {
  const { model, clip } = fixture();
  expect(() => convertMixamoToVrmAnimation(model, clip, { metersPerUnit: 0.01 })).toThrow(/reference/i);
  const bad = clip.clone(); bad.tracks.push(new VectorKeyframeTrack('mixamorigLeftArm.scale', [0, 1], [1, 1, 1, 2, 2, 2]));
  expect(() => convertMixamoToVrmAnimation(model, bad, { metersPerUnit: 0.01, referencePose: captureModelReferencePose(model) })).toThrow(/Unsupported animated/);
  expect(() => inspectVrmAnimation(new Uint8Array(32))).toThrow(/GLB/);
  const duplicate = new Bone(); duplicate.name = 'mixamorigLeftArm'; model.add(duplicate);
  expect(() => convertMixamoToVrmAnimation(model, clip, { metersPerUnit: 0.01, referencePose: captureModelReferencePose(model) })).toThrow(/uniquely/);
});

it('rejects native additive clips instead of reinterpreting rotation deltas as absolute keys', () => {
  const { model, clip } = fixture();
  clip.blendMode = AdditiveAnimationBlendMode;
  expect(() => convertMixamoToVrmAnimation(model, clip, {
    metersPerUnit: 0.01, referencePose: captureModelReferencePose(model),
  })).toThrow(/absolute local.*additive/i);
});

it('accepts complete explicit target maps without scheduling eye animation', () => {
  const source = fixture(); const target = fixture();
  const bytes = convertMixamoToVrmAnimation(source.model, source.clip, {
    metersPerUnit: 0.01, referencePose: captureModelReferencePose(source.model),
  });
  const eye = new Bone(); eye.name = 'EyeLeft'; target.bones.head.add(eye);
  const clip = createAnimationClipFromVrmAnimation(bytes, target.model, {
    metersPerUnit: 0.01, referencePose: captureModelReferencePose(target.model),
    humanoidBones: { ...target.humanoidBones, leftEye: eye.name },
  });
  expect(clip.tracks).toHaveLength(2);
  expect(clip.tracks.some((track) => track.name.startsWith(eye.uuid))).toBe(false);
});

it('file conversion owns temporary FBX resources on both success and conversion failure', () => {
  const source = fixture(true);
  const disposeGeometry = vi.spyOn(source.mesh.geometry, 'dispose');
  const disposeMaterial = vi.spyOn(source.mesh.material, 'dispose');
  const parse = vi.spyOn(FBXLoader.prototype, 'parse').mockReturnValue(source.model);
  try {
    const result = convertMixamoFbxToVrmAnimations(new ArrayBuffer(8), { metersPerUnit: 0.01 });
    expect(result[0].name).toBe('Raised arm'); expect(disposeGeometry).toHaveBeenCalledOnce(); expect(disposeMaterial).toHaveBeenCalledOnce();
    source.clip.tracks[0].name = 'missing.quaternion';
    expect(() => convertMixamoFbxToVrmAnimations(new ArrayBuffer(8), { metersPerUnit: 0.01 })).toThrow(/uniquely/);
    expect(disposeGeometry).toHaveBeenCalledTimes(2); expect(disposeMaterial).toHaveBeenCalledTimes(2);
  } finally { parse.mockRestore(); }
});
