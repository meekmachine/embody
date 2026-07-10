import { describe, expect, it } from 'vitest';
import { BufferGeometry, Mesh, MeshBasicMaterial, Object3D, Quaternion } from 'three';
import type { Profile } from '../../mappings/types';
import type { CompositeRotation, SnippetChannel } from '../../core/types';
import type { ResolvedBones } from './types';
import { AnimationController, type AnimationControllerHost } from './AnimationThree';

function makeMorphMesh(name: string, dictionary: Record<string, number>): Mesh {
  const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.name = name;
  (mesh as any).morphTargetDictionary = dictionary;
  const maxIndex = Object.values(dictionary).length > 0 ? Math.max(...Object.values(dictionary)) : -1;
  (mesh as any).morphTargetInfluences = maxIndex >= 0 ? new Array(maxIndex + 1).fill(0) : [];
  return mesh;
}

function makeBone(name = 'Head') {
  const obj = new Object3D();
  obj.name = name;
  return {
    obj,
    basePos: { x: 0, y: 0, z: 0 },
    baseQuat: new Quaternion(),
    baseEuler: { x: 0, y: 0, z: 0, order: 'XYZ' as const },
  };
}

function makeHost(
  profile: Profile,
  meshes: Mesh[],
  bones: ResolvedBones = {},
  compositeRotations: CompositeRotation[] = []
): AnimationControllerHost {
  const model = new Object3D();
  meshes.forEach((mesh) => model.add(mesh));
  Object.values(bones).forEach((bone) => {
    if (bone) model.add(bone.obj);
  });

  const meshMap = new Map(meshes.map((mesh) => [mesh.name, mesh]));
  const readMorph = (morphKey: string, meshNames?: string[]) => {
    for (const name of meshNames ?? profile.morphToMesh?.face ?? []) {
      const mesh = meshMap.get(name);
      const dict = mesh?.morphTargetDictionary;
      const infl = mesh?.morphTargetInfluences;
      if (!dict || !infl || dict[morphKey] === undefined) continue;
      return infl[dict[morphKey]] ?? 0;
    }
    return 0;
  };
  const readMorphIndex = (morphIndex: number, meshNames?: string[]) => {
    for (const name of meshNames ?? profile.morphToMesh?.face ?? []) {
      const infl = meshMap.get(name)?.morphTargetInfluences;
      if (!infl || morphIndex < 0 || morphIndex >= infl.length) continue;
      return infl[morphIndex] ?? 0;
    }
    return 0;
  };

  return {
    getModel: () => model,
    getMeshes: () => meshes,
    getMeshByName: (name: string) => meshMap.get(name),
    getMeshNamesForAU: () => profile.morphToMesh?.face ?? [],
    getMeshNamesForViseme: () => profile.morphToMesh?.viseme ?? profile.morphToMesh?.face ?? [],
    getCurrentAUValue: () => 0,
    getCurrentVisemeValue: () => 0,
    getCurrentMorphValue: readMorph,
    getCurrentMorphIndexValue: readMorphIndex,
    getCurrentBoneQuaternion: (nodeKey: string) => bones[nodeKey]?.obj.quaternion.clone() ?? null,
    getCurrentBonePositionValue: (nodeKey: string, axis: 'x' | 'y' | 'z') => bones[nodeKey]?.obj.position[axis] ?? null,
    getBones: () => bones,
    getConfig: () => profile,
    getCompositeRotations: () => compositeRotations,
    computeSideValues: (base: number) => ({ left: base, right: base }),
    getAUMixWeight: () => 1,
    isMixedAU: () => false,
  };
}

function trackValues(clip: NonNullable<ReturnType<AnimationController['typedSnippetToClip']>>, namePart: string): number[] {
  const track = clip.tracks.find((entry) => entry.name.includes(namePart));
  expect(track).toBeTruthy();
  return Array.from(track!.values as ArrayLike<number>);
}

function expectValuesCloseTo(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => {
    expect(actual[index]).toBeCloseTo(value);
  });
}

describe('AnimationController typed snippet channels', () => {
  it('routes colliding AU and viseme numeric ids without snippetCategory', () => {
    const face = makeMorphMesh('Face', { AU1: 0, Viseme1: 1 });
    const profile: Profile = {
      auToMorphs: {
        1: { left: [], right: [], center: ['AU1'] },
      },
      auToBones: {},
      boneNodes: {},
      morphToMesh: { face: ['Face'], viseme: ['Face'] },
      visemeKeys: [],
      visemeSlots: [
        { id: 'silence', label: 'Silence', order: 0 },
        { id: 'v1', label: 'V1', order: 1 },
      ],
      visemeBindings: {
        v1: { targets: [{ morph: 'Viseme1', weight: 1 }] },
      },
      visemeMeshCategory: 'viseme',
    };
    const controller = new AnimationController(makeHost(profile, [face]));

    const clip = controller.typedSnippetToClip('typed-collision', [
      {
        target: { type: 'au', id: 1 },
        keyframes: [{ time: 0, intensity: 0 }, { time: 0.1, intensity: 0.7 }],
      },
      {
        target: { type: 'viseme', id: 1 },
        keyframes: [{ time: 0, intensity: 0 }, { time: 0.1, intensity: 0.9 }],
      },
    ]);

    expect(clip).toBeTruthy();
    expectValuesCloseTo(trackValues(clip!, `${(face as any).uuid}.morphTargetInfluences[0]`), [0, 0.7]);
    expectValuesCloseTo(trackValues(clip!, `${(face as any).uuid}.morphTargetInfluences[1]`), [0, 0.9]);
  });

  it('supports direct morph and bone channels in the same typed snippet shape', () => {
    const face = makeMorphMesh('Face', { Smile: 0 });
    const head = makeBone('Head');
    const bones: ResolvedBones = { HEAD: head };
    const profile: Profile = {
      auToMorphs: {},
      auToBones: {},
      boneNodes: {},
      morphToMesh: { face: ['Face'] },
      visemeKeys: [],
    };
    const controller = new AnimationController(makeHost(profile, [face], bones));
    const channels: SnippetChannel[] = [
      {
        target: { type: 'morph', id: 'Smile', meshNames: ['Face'] },
        keyframes: [{ time: 0, intensity: 0 }, { time: 0.2, intensity: 1 }],
      },
      {
        target: { type: 'bone', id: 'HEAD', channel: 'ry', maxDegrees: 20 },
        keyframes: [{ time: 0, intensity: 0 }, { time: 0.2, intensity: 0.5 }],
      },
    ];

    const clip = controller.typedSnippetToClip('typed-morph-bone', channels);

    expect(clip).toBeTruthy();
    expectValuesCloseTo(trackValues(clip!, `${(face as any).uuid}.morphTargetInfluences[0]`), [0, 1]);
    const quaternionTrack = clip!.tracks.find((track) => track.name === `${(head.obj as any).uuid}.quaternion`);
    expect(quaternionTrack).toBeTruthy();
    expect(Array.from(quaternionTrack!.values as ArrayLike<number>).slice(4)).not.toEqual([0, 0, 0, 1]);
  });

  it('routes typed AU channels through profile composite bone rotations', () => {
    const jaw = makeBone('Jaw');
    const bones: ResolvedBones = { JAW: jaw };
    const profile: Profile = {
      auToMorphs: {},
      auToBones: {
        26: [{ node: 'JAW', channel: 'rz', scale: 1, maxDegrees: 30 }],
      },
      boneNodes: { JAW: 'Jaw' },
      morphToMesh: {},
      visemeKeys: [],
    };
    const compositeRotations: CompositeRotation[] = [
      {
        node: 'JAW',
        pitch: { aus: [26], axis: 'rz' },
        yaw: null,
        roll: null,
      },
    ];
    const controller = new AnimationController(makeHost(profile, [], bones, compositeRotations));

    const clip = controller.typedSnippetToClip('typed-au-jaw', [
      {
        target: { type: 'au', id: 26 },
        keyframes: [{ time: 0, intensity: 0 }, { time: 0.2, intensity: 1 }],
      },
    ], { autoVisemeJaw: false });

    expect(clip).toBeTruthy();
    const quaternionTrack = clip!.tracks.find((track) => track.name === `${(jaw.obj as any).uuid}.quaternion`);
    expect(quaternionTrack).toBeTruthy();
    const values = Array.from(quaternionTrack!.values as ArrayLike<number>);
    expect(values.slice(0, 4)).toEqual([0, 0, 0, 1]);
    expect(Math.abs(values[6])).toBeGreaterThan(0.1);
  });

  it('routes lip-sync control 103 to the jaw bone without creating Jaw_Open morph tracks', () => {
    const face = makeMorphMesh('Face', { Jaw_Open: 0 });
    const jaw = makeBone('Jaw');
    const bones: ResolvedBones = { JAW: jaw };
    const profile: Profile = {
      auToMorphs: {
        26: { left: [], right: [], center: ['Jaw_Open'] },
      },
      auToBones: {},
      lipSyncToBones: {
        103: [{ node: 'JAW', channel: 'rz', scale: 1, maxDegrees: 30 }],
      },
      boneNodes: { JAW: 'Jaw' },
      morphToMesh: { face: ['Face'] },
      visemeKeys: [],
    };
    const compositeRotations: CompositeRotation[] = [
      {
        node: 'JAW',
        pitch: { aus: [26], axis: 'rz' },
        yaw: null,
        roll: null,
      },
    ];
    const controller = new AnimationController(makeHost(profile, [face], bones, compositeRotations));

    const clip = controller.typedSnippetToClip('typed-lipsync-jaw', [
      {
        target: { type: 'lipSync', id: 103 },
        keyframes: [{ time: 0, intensity: 0 }, { time: 0.2, intensity: 1 }],
      },
    ], { autoVisemeJaw: false });

    expect(clip).toBeTruthy();
    expect(clip!.tracks.some((track) => track.name.includes('morphTargetInfluences'))).toBe(false);
    const quaternionTrack = clip!.tracks.find((track) => track.name === `${(jaw.obj as any).uuid}.quaternion`);
    expect(quaternionTrack).toBeTruthy();
    const values = Array.from(quaternionTrack!.values as ArrayLike<number>);
    expect(values.slice(0, 4)).toEqual([0, 0, 0, 1]);
    expect(Math.abs(values[6])).toBeGreaterThan(0.1);
  });
});
