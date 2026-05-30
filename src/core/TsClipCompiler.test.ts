import { describe, expect, it } from 'vitest';
import type { ChannelId, MeshId, MorphTargetId, BoneId } from './contracts';
import { TsClipCompiler } from './TsClipCompiler';

const channelId = (value: number) => value as ChannelId;
const meshId = (value: number) => value as MeshId;
const morphTargetId = (value: number) => value as MorphTargetId;
const boneId = (value: number) => value as BoneId;

describe('TsClipCompiler', () => {
  it('compiles authored keyframes into host-neutral ClipIR', () => {
    const compiler = new TsClipCompiler();

    expect(compiler.compile({
      name: 'core-smile',
      channels: [{ id: channelId(2), kind: 'face', name: 'face' }],
      tracks: [
        {
          channelId: channelId(2),
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
          channelId: channelId(2),
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
    })).toEqual({
      id: undefined,
      name: 'core-smile',
      durationSeconds: 0.5,
      channels: [{ id: channelId(2), kind: 'face', name: 'face' }],
      tracks: [
        {
          id: 1,
          channelId: channelId(2),
          target: {
            kind: 'morphTarget',
            meshId: meshId(1),
            morphTargetId: morphTargetId(10),
          },
          valueType: 'scalar',
          times: [0, 0.5],
          values: [0, 1],
          interpolation: undefined,
        },
        {
          id: 2,
          channelId: channelId(2),
          target: {
            kind: 'boneTransform',
            boneId: boneId(20),
            property: 'rotation',
          },
          valueType: 'quat',
          times: [0, 0.5],
          values: [0, 0, 0, 1, 0, 0.382683, 0, 0.92388],
          interpolation: undefined,
        },
      ],
      metadata: undefined,
    });
  });

  it('compiles resolved curve targets into ClipIR tracks', () => {
    const clip = new TsClipCompiler().compileCurves({
      name: 'curve-smile',
      curves: {
        smile: [
          { time: 0, intensity: 0.25 },
          { time: 1, intensity: 0.75 },
        ],
      },
      targets: {
        smile: [
          {
            target: {
              kind: 'morphTarget',
              meshId: meshId(1),
              morphTargetId: morphTargetId(10),
            },
            scale: 0.5,
          },
          {
            target: {
              kind: 'morphTarget',
              meshId: meshId(1),
              morphTargetId: morphTargetId(11),
            },
            scale: 1,
          },
        ],
      },
      intensityScale: 2,
    });

    expect(clip.tracks.map((track) => track.values)).toEqual([
      [0.25, 0.75],
      [0.5, 1.5],
    ]);
    expect(clip.durationSeconds).toBe(1);
  });

  it('rejects mismatched keyframe value sizes', () => {
    expect(() => new TsClipCompiler().compile({
      name: 'bad',
      tracks: [
        {
          target: {
            kind: 'boneTransform',
            boneId: boneId(1),
            property: 'position',
          },
          valueType: 'vec3',
          keyframes: [{ time: 0, value: [0, 1] }],
        },
      ],
    })).toThrow(/Expected 3 values/);
  });
});
