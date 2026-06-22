import { describe, expect, it, vi } from 'vitest';
import { BufferAttribute } from 'three';
import type { SnippetChannel } from '../../core/types';
import type { ResolvedBones } from './types';
import { partitionBakedClip } from './bakedClipPartitioning';
import {
  makePolymerCombinedVocalChannels,
  makePolymerJawVocalChannels,
  makePolymerLipVocalChannels,
  makeMixedBakedClip,
  makeParityScene,
  snapshotBones,
  snapshotClip,
  snapshotMorphInfluences,
} from './parityFixtures';

const runtimeDelta = new Float32Array([
  0, 0.05, 0,
  0, 0.05, 0,
  0, 0.05, 0,
]);

const polymerVocalPlaybackOptions = {
  loopMode: 'once' as const,
  autoVisemeJaw: false,
};

function seekRequired(handle: { setTime?: (time: number) => void } | null, time = 0.5): void {
  expect(handle).toBeTruthy();
  expect(handle?.setTime).toBeTypeOf('function');
  handle!.setTime!(time);
}

function expectPolymerLipPose(viseme: ReturnType<typeof makeParityScene>['viseme']): void {
  expect(snapshotMorphInfluences(viseme)).toEqual({
    Mouth_Aah: 0.8,
    Mouth_Wide: 0.4,
    Shared_Mouth: 0.3,
  });
}

function expectNeutralLipPose(viseme: ReturnType<typeof makeParityScene>['viseme']): void {
  expect(snapshotMorphInfluences(viseme)).toEqual({
    Mouth_Aah: 0,
    Mouth_Wide: 0,
    Shared_Mouth: 0,
  });
}

describe('Three parity fixtures', () => {
  it('captures live AU morph writes with balance', () => {
    const { engine, face } = makeParityScene();

    engine.setAU(1, 0.8, -0.25);

    expect(snapshotMorphInfluences(face)).toEqual({
      BrowUp_L: 0.8,
      BrowUp_R: 0.6,
      BrowCenter: 0.8,
      Smile: 0,
      LookLeft: 0,
      LookRight: 0,
      RuntimeSmile: 0,
    });
  });

  it('captures weighted viseme writes and jaw output', () => {
    const { engine, viseme } = makeParityScene();

    engine.setVisemeById('aa', 0.75);
    engine.update(1 / 60);

    expect(snapshotMorphInfluences(viseme)).toEqual({
      Mouth_Aah: 0.75,
      Mouth_Wide: 0.375,
      Shared_Mouth: 0,
    });
    expect(snapshotBones(engine).JAW).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 18],
    });
  });

  it('captures continuum and composite bone output', () => {
    const { engine } = makeParityScene();

    engine.setContinuum(30, 31, -0.5);
    engine.update(1 / 60);
    const negative = snapshotBones(engine).HEAD;

    engine.setContinuum(30, 31, 0.25);
    engine.update(1 / 60);
    const positive = snapshotBones(engine).HEAD;

    expect(negative).toEqual({
      position: [0, 0, 0],
      rotation: [0, -10, 0],
    });
    expect(positive).toEqual({
      position: [0, 0, 0],
      rotation: [0, 5, 0],
    });
  });

  it('captures dynamic clip output in normalized host-readable form', () => {
    const scene = makeParityScene();

    const clip = scene.engine.snippetToClip('parity-smile', {
      '1': [
        { time: 0, intensity: 0 },
        { time: 0.5, intensity: 1 },
      ],
      '30': [
        { time: 0, intensity: 0 },
        { time: 0.5, intensity: 0.5 },
      ],
    }, { balance: -0.5 });

    expect(clip).not.toBeNull();
    expect(snapshotClip(clip!, scene)).toMatchInlineSnapshot(`
      {
        "duration": 0.5,
        "name": "parity-smile",
        "trackCount": 5,
        "tracks": [
          {
            "name": "FaceMesh.morphTargetInfluences[0]",
            "times": [
              0,
              0.5,
            ],
            "type": "number",
            "values": [
              0,
              1,
            ],
          },
          {
            "name": "FaceMesh.morphTargetInfluences[1]",
            "times": [
              0,
              0.5,
            ],
            "type": "number",
            "values": [
              0,
              0.5,
            ],
          },
          {
            "name": "FaceMesh.morphTargetInfluences[2]",
            "times": [
              0,
              0.5,
            ],
            "type": "number",
            "values": [
              0,
              1,
            ],
          },
          {
            "name": "FaceMesh.morphTargetInfluences[4]",
            "times": [
              0,
              0.5,
            ],
            "type": "number",
            "values": [
              0,
              0.25,
            ],
          },
          {
            "name": "Head.quaternion",
            "times": [
              0,
              0.5,
            ],
            "type": "quaternion",
            "values": [
              0,
              0,
              0,
              1,
              0,
              -0.087156,
              0,
              0.996195,
            ],
          },
        ],
      }
    `);
  });

  it('captures baked clip partitioning summaries', () => {
    const scene = makeParityScene();
    const bones: ResolvedBones = {
      HEAD: {
        obj: scene.head,
        basePos: { x: 0, y: 0, z: 0 },
        baseQuat: scene.head.quaternion.clone(),
        baseEuler: {
          x: 0,
          y: 0,
          z: 0,
          order: scene.head.rotation.order,
        },
      },
    };

    const partitioned = partitionBakedClip(makeMixedBakedClip(scene), scene.model, bones);

    expect(partitioned.channels).toEqual([
      { channel: 'face', trackCount: 2, playable: true, blendMode: 'additive' },
      { channel: 'body', trackCount: 1, playable: true, blendMode: 'replace' },
      { channel: 'scene', trackCount: 1, playable: false, blendMode: undefined },
    ]);
    expect(partitioned.mixerClips.map((entry) => ({
      channel: entry.channel,
      trackNames: entry.clip.tracks.map((track) => track.name),
    }))).toEqual([
      {
        channel: 'face',
        trackNames: [
          `${scene.face.uuid}.morphTargetInfluences[0]`,
          `${scene.head.uuid}.quaternion`,
        ],
      },
      {
        channel: 'body',
        trackNames: [`${scene.body.uuid}.position[x]`],
      },
    ]);
  });

  it('captures runtime morph authoring cache refresh', () => {
    const { engine, face } = makeParityScene();

    engine.addMorphTarget({
      meshName: 'FaceMesh',
      name: 'GeneratedSmile',
      position: runtimeDelta,
    }, { forceGeometryReplacement: false });

    engine.setMorph('GeneratedSmile', 0.625, ['FaceMesh']);

    expect(face.morphTargetDictionary?.GeneratedSmile).toBe(7);
    expect(face.morphTargetInfluences?.[7]).toBe(0.625);
    expect(face.geometry.morphAttributes.position?.[7]).toBeInstanceOf(BufferAttribute);
  });

  it('runs a Polymer-style lip-only vocal snippet without synthesizing jaw motion', () => {
    const { engine, viseme } = makeParityScene();

    const handle = engine.playTypedSnippet(
      { name: 'polymer-lip-only-vocal', channels: makePolymerLipVocalChannels() },
      polymerVocalPlaybackOptions
    );
    seekRequired(handle);

    expectPolymerLipPose(viseme);
    expect(snapshotBones(engine).JAW.rotation[2]).toBeCloseTo(0);
  });

  it('runs a Polymer-style jaw-only vocal snippet through AU 26 where mapped', () => {
    const { engine, viseme } = makeParityScene();

    const handle = engine.playTypedSnippet(
      { name: 'polymer-jaw-only-vocal', channels: makePolymerJawVocalChannels() },
      polymerVocalPlaybackOptions
    );
    seekRequired(handle);

    expectNeutralLipPose(viseme);
    expect(snapshotBones(engine).JAW.rotation[2]).toBeCloseTo(22.5);
  });

  it('runs combined Polymer-style lip and AU 26 channels independently', () => {
    const { engine, viseme } = makeParityScene();

    const handle = engine.playTypedSnippet(
      { name: 'polymer-combined-vocal', channels: makePolymerCombinedVocalChannels() },
      polymerVocalPlaybackOptions
    );
    seekRequired(handle);

    expectPolymerLipPose(viseme);
    expect(snapshotBones(engine).JAW.rotation[2]).toBeCloseTo(22.5);
  });

  it('layers a combined Polymer-style vocal snippet with another non-vocal snippet', () => {
    const { engine, face, viseme } = makeParityScene();

    const vocal = engine.playTypedSnippet(
      { name: 'polymer-layered-vocal', channels: makePolymerCombinedVocalChannels() },
      polymerVocalPlaybackOptions
    );
    const expression = engine.playSnippet({
      name: 'non-vocal-runtime-smile',
      curves: {
        RuntimeSmile: [
          { time: 0, intensity: 0 },
          { time: 0.5, intensity: 0.6 },
        ],
      },
    }, { loopMode: 'once' });

    seekRequired(vocal);
    seekRequired(expression);

    expectPolymerLipPose(viseme);
    expect(snapshotBones(engine).JAW.rotation[2]).toBeCloseTo(22.5);
    expect(snapshotMorphInfluences(face)).toMatchObject({
      RuntimeSmile: 0.6,
    });
  });

  it('documents unsupported future vocal target types without dropping supported channels', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { engine, viseme } = makeParityScene();
      const channels = [
        ...makePolymerLipVocalChannels(),
        {
          target: { type: 'tongue', id: 'tip' },
          keyframes: [
            { time: 0, intensity: 0 },
            { time: 0.5, intensity: 1 },
          ],
        },
      ] as unknown as SnippetChannel[];

      const handle = engine.playTypedSnippet(
        { name: 'polymer-future-vocal-target', channels },
        polymerVocalPlaybackOptions
      );
      seekRequired(handle);

      expectPolymerLipPose(viseme);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported typed snippet target "tongue"')
      );
    } finally {
      warn.mockRestore();
    }
  });

});
