import { describe, expect, it } from 'vitest';
import { ThreeModelInspector } from '../engines/three/ThreeModelInspector';
import { makeProfileTestScene } from '../engines/three/profileTestScene';
import { TsRuntimeCore } from './TsRuntimeCore';
import type { FrameDelta, ModelDescriptor } from './contracts';

function makeCore() {
  const scene = makeProfileTestScene();
  const descriptor = new ThreeModelInspector().inspectModel(scene.model, {
    meshes: [scene.face, scene.viseme, scene.hair],
    profile: scene.profile,
  }).descriptor;
  return {
    ...scene,
    descriptor,
    core: new TsRuntimeCore({
      profile: scene.profile,
      model: descriptor,
    }),
  };
}

function morphWritesByName(frame: FrameDelta, descriptor: ModelDescriptor): Record<string, number> {
  const result: Record<string, number> = {};
  for (const write of frame.morphTargets || []) {
    const morph = descriptor.morphTargets.find((target) => target.id === write.morphTargetId);
    const mesh = descriptor.meshes.find((candidate) => candidate.id === write.meshId);
    if (morph && mesh) {
      result[`${mesh.name}:${morph.name}`] = round(write.value);
    }
  }
  return result;
}

function boneRotationsByName(frame: FrameDelta, descriptor: ModelDescriptor): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const write of frame.bones || []) {
    const bone = descriptor.bones.find((candidate) => candidate.id === write.boneId);
    const rotation = write.transform.rotation;
    if (bone && rotation) {
      result[bone.name] = [
        round(rotation.x),
        round(rotation.y),
        round(rotation.z),
        round(rotation.w),
      ];
    }
  }
  return result;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

describe('TsRuntimeCore', () => {
  it('solves AU morph writes without Three objects', () => {
    const { core, descriptor } = makeCore();

    core.setAU(1, 0.8, -0.25);

    expect(morphWritesByName(core.evaluateFrameDelta(), descriptor)).toMatchObject({
      'FaceMesh:BrowUp_L': 0.8,
      'FaceMesh:BrowUp_R': 0.6,
      'FaceMesh:BrowCenter': 0.8,
    });
  });

  it('solves weighted viseme writes and jaw rotation', () => {
    const { core, descriptor } = makeCore();

    core.setVisemeById('aa', 0.75);
    const frame = core.evaluateFrameDelta();

    expect(morphWritesByName(frame, descriptor)).toMatchObject({
      'VisemeMesh:Mouth_Aah': 0.75,
      'VisemeMesh:Mouth_Wide': 0.375,
    });
    expect(boneRotationsByName(frame, descriptor).Jaw).toEqual([
      0,
      0,
      0.156434,
      0.987688,
    ]);
  });

  it('solves continuum composite bone rotations', () => {
    const { core, descriptor } = makeCore();

    core.setContinuum(30, 31, -0.5);
    const negative = boneRotationsByName(core.evaluateFrameDelta(), descriptor).Head;

    core.setContinuum(30, 31, 0.25);
    const positive = boneRotationsByName(core.evaluateFrameDelta(), descriptor).Head;

    expect(negative).toEqual([0, -0.087156, 0, 0.996195]);
    expect(positive).toEqual([0, 0.043619, 0, 0.999048]);
  });
});
