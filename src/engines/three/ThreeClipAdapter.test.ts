import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import type { BoneId, MeshId, MorphTargetId } from '../../core/contracts';
import { TsClipCompiler } from '../../core/TsClipCompiler';
import { ThreeClipAdapter } from './ThreeClipAdapter';

const meshId = (value: number) => value as MeshId;
const morphTargetId = (value: number) => value as MorphTargetId;
const boneId = (value: number) => value as BoneId;

describe('ThreeClipAdapter', () => {
  it('converts ClipIR morph and bone tracks to Three AnimationClip tracks', () => {
    const head = new Object3D();
    head.name = 'Head';
    const clipIR = new TsClipCompiler().compile({
      name: 'adapter-smile',
      tracks: [
        {
          target: {
            kind: 'morphTarget',
            meshId: meshId(1),
            morphTargetId: morphTargetId(10),
          },
          valueType: 'scalar',
          keyframes: [
            { time: 0, value: 0 },
            { time: 0.5, value: 1 },
          ],
        },
        {
          target: {
            kind: 'boneTransform',
            boneId: boneId(20),
            property: 'rotation',
          },
          valueType: 'quat',
          keyframes: [
            { time: 0, value: [0, 0, 0, 1] },
            { time: 0.5, value: [0, 0.382683, 0, 0.92388] },
          ],
        },
      ],
    });

    const clip = new ThreeClipAdapter({
      meshes: new Map([[meshId(1), { trackName: 'FaceMesh' }]]),
      morphTargets: new Map([[morphTargetId(10), { meshId: meshId(1), index: 2 }]]),
      bones: new Map([[boneId(20), head]]),
    }).toAnimationClip(clipIR);

    expect(clip.name).toBe('adapter-smile');
    expect(clip.duration).toBe(0.5);
    expect(clip.tracks.map((track) => ({
      name: track.name,
      type: track.ValueTypeName,
      times: Array.from(track.times),
      values: Array.from(track.values).map((value) => Number(value.toFixed(6))),
    }))).toEqual([
      {
        name: 'FaceMesh.morphTargetInfluences[2]',
        type: 'number',
        times: [0, 0.5],
        values: [0, 1],
      },
      {
        name: `${head.uuid}.quaternion`,
        type: 'quaternion',
        times: [0, 0.5],
        values: [0, 0, 0, 1, 0, 0.382683, 0, 0.92388],
      },
    ]);
  });
});
