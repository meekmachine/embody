import {
  AnimationClip,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  Object3D,
  QuaternionKeyframeTrack,
} from 'three';
import type { KeyframeTrack } from 'three';
import type { Profile } from '../../mappings/types';
import type { SnippetChannel } from '../../core/types';
import { Embody } from './Embody';

export const FACE_MORPHS = [
  'BrowUp_L',
  'BrowUp_R',
  'BrowCenter',
  'Smile',
  'LookLeft',
  'LookRight',
  'RuntimeSmile',
] as const;

export const VISEME_MORPHS = [
  'Mouth_Aah',
  'Mouth_Wide',
  'Shared_Mouth',
] as const;

export const HAIR_MORPHS = [
  'L_Hair_Left',
  'L_Hair_Right',
  'L_Hair_Front',
  'Fluffy_Right',
  'Fluffy_Bottom_ALL',
  'Hairline_High_ALL',
  'Length_Short',
] as const;

export type ProfileTestScene = {
  profile: Profile;
  model: Object3D;
  engine: Embody;
  face: Mesh;
  viseme: Mesh;
  hair: Mesh;
  head: Object3D;
  jaw: Object3D;
  body: Object3D;
  camera: Object3D;
};

export function makeMorphGeometry(morphKeys: readonly string[] = []): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ]), 3));

  if (morphKeys.length > 0) {
    geometry.morphAttributes.position = morphKeys.map((key, index) => {
      const value = (index + 1) / 100;
      const attribute = new BufferAttribute(new Float32Array([
        0, value, 0,
        0, value, 0,
        0, value, 0,
      ]), 3);
      (attribute as { name?: string }).name = key;
      return attribute;
    });
    geometry.morphTargetsRelative = true;
  }

  return geometry;
}

export function makeMorphMesh(name: string, morphKeys: readonly string[] = []): Mesh {
  const mesh = new Mesh(makeMorphGeometry(morphKeys), new MeshBasicMaterial());
  mesh.name = name;
  if (morphKeys.length > 0) {
    mesh.morphTargetDictionary = Object.fromEntries(morphKeys.map((key, index) => [key, index]));
    mesh.morphTargetInfluences = new Array(morphKeys.length).fill(0);
  }
  return mesh;
}

export function makeTestProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: 'Three profile test scene',
    auToMorphs: {
      1: { left: ['BrowUp_L'], right: ['BrowUp_R'], center: ['BrowCenter'] },
      2: { left: [], right: [], center: ['Smile'] },
      30: { left: [], right: [], center: ['LookLeft'] },
      31: { left: [], right: [], center: ['LookRight'] },
    },
    auToBones: {
      26: [{ node: 'JAW', channel: 'rz', scale: 1, maxDegrees: 30 }],
      30: [{ node: 'HEAD', channel: 'ry', scale: -1, maxDegrees: 20 }],
      31: [{ node: 'HEAD', channel: 'ry', scale: 1, maxDegrees: 20 }],
      103: [{ node: 'JAW', channel: 'rz', scale: 1, maxDegrees: 30 }],
    },
    boneNodes: {
      HEAD: 'Head',
      JAW: 'Jaw',
    },
    morphToMesh: {
      face: ['FaceMesh'],
      viseme: ['VisemeMesh'],
      hair: ['HairMesh'],
    },
    visemeKeys: ['Mouth_Aah', 'Shared_Mouth'],
    visemeSlots: [
      { id: 'aa', label: 'AA', order: 0, defaultJawAmount: 0.8 },
      { id: 'bmp', label: 'B/M/P', order: 1, defaultJawAmount: 0.2 },
    ],
    visemeBindings: {
      aa: {
        targets: [
          { morph: 'Mouth_Aah' },
          { morph: 'Mouth_Wide', weight: 0.5 },
        ],
      },
      bmp: {
        targets: [{ morph: 'Shared_Mouth', weight: 0.6 }],
      },
    },
    visemeMeshCategory: 'viseme',
    visemeJawAmounts: [0.8, 0.2],
    compositeRotations: [
      {
        node: 'JAW',
        pitch: { aus: [26, 103], axis: 'rz' },
        yaw: null,
        roll: null,
      },
      {
        node: 'HEAD',
        pitch: null,
        yaw: { aus: [30, 31], axis: 'ry', negative: 30, positive: 31 },
        roll: null,
      },
    ],
    continuumPairs: {
      30: { pairId: 31, isNegative: true, axis: 'yaw', node: 'HEAD' },
      31: { pairId: 30, isNegative: false, axis: 'yaw', node: 'HEAD' },
    },
    hairPhysics: {
      idleSwayAmount: 0.08,
      idleSwaySpeed: 0.75,
      windStrength: 0.15,
      idleClipDuration: 2,
      impulseClipDuration: 0.75,
    },
    ...overrides,
  };
}

export function makeProfileTestScene(profile: Profile = makeTestProfile()): ProfileTestScene {
  const model = new Object3D();
  model.name = 'ProfileTestModel';

  const head = new Object3D();
  head.name = 'Head';
  const jaw = new Object3D();
  jaw.name = 'Jaw';
  const body = new Object3D();
  body.name = 'Hips';
  const camera = new Object3D();
  camera.name = 'PreviewCamera';
  (camera as { isCamera?: boolean }).isCamera = true;

  const face = makeMorphMesh('FaceMesh', FACE_MORPHS);
  const viseme = makeMorphMesh('VisemeMesh', VISEME_MORPHS);
  const hair = makeMorphMesh('HairMesh', HAIR_MORPHS);

  model.add(head, jaw, body, camera, face, viseme, hair);

  const engine = new Embody({ profile });
  engine.onReady({ model, meshes: [face, viseme, hair] });
  engine.registerHairObjects([hair]);

  return { profile, model, engine, face, viseme, hair, head, jaw, body, camera };
}

export function makePolymerLipVocalChannels(): SnippetChannel[] {
  return [
    {
      target: { type: 'viseme', id: 0 },
      keyframes: [
        { time: 0, intensity: 0 },
        { time: 0.5, intensity: 0.8 },
      ],
    },
    {
      target: { type: 'viseme', id: 1 },
      keyframes: [
        { time: 0, intensity: 0 },
        { time: 0.5, intensity: 0.5 },
      ],
    },
  ];
}

export function makePolymerJawVocalChannels(): SnippetChannel[] {
  return [
    {
      target: { type: 'lipSync', id: 103 },
      keyframes: [
        { time: 0, intensity: 0 },
        { time: 0.5, intensity: 0.75 },
      ],
    },
  ];
}

export function makePolymerCombinedVocalChannels(): SnippetChannel[] {
  return [
    ...makePolymerLipVocalChannels(),
    ...makePolymerJawVocalChannels(),
  ];
}

export function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

export function snapshotMorphInfluences(mesh: Mesh): Record<string, number> {
  const dict = mesh.morphTargetDictionary ?? {};
  const influences = mesh.morphTargetInfluences ?? [];
  return Object.fromEntries(
    Object.entries(dict)
      .sort((a, b) => a[1] - b[1])
      .map(([name, index]) => [name, round(influences[index] ?? 0)])
  );
}

export function snapshotBones(engine: Embody): Record<string, { position: number[]; rotation: number[] }> {
  const bones = engine.getBones();
  return Object.fromEntries(
    Object.entries(bones).map(([name, value]) => [
      name,
      {
        position: value.position.map((entry) => round(entry)),
        rotation: value.rotation.map((entry) => round(entry)),
      },
    ])
  );
}

export function normalizeTrackName(trackName: string, scene: Pick<ProfileTestScene, 'face' | 'viseme' | 'hair' | 'head' | 'jaw' | 'body' | 'camera'>): string {
  const replacements = new Map([
    [scene.face.uuid, scene.face.name],
    [scene.viseme.uuid, scene.viseme.name],
    [scene.hair.uuid, scene.hair.name],
    [scene.head.uuid, scene.head.name],
    [scene.jaw.uuid, scene.jaw.name],
    [scene.body.uuid, scene.body.name],
    [scene.camera.uuid, scene.camera.name],
  ]);

  let normalized = trackName;
  for (const [uuid, name] of replacements) {
    normalized = normalized.replace(uuid, name);
  }
  return normalized;
}

export function snapshotTrack(track: KeyframeTrack, scene: Pick<ProfileTestScene, 'face' | 'viseme' | 'hair' | 'head' | 'jaw' | 'body' | 'camera'>) {
  return {
    name: normalizeTrackName(track.name, scene),
    type: track.ValueTypeName,
    times: Array.from(track.times).map((value) => round(value)),
    values: Array.from(track.values).map((value) => round(value)),
  };
}

export function snapshotClip(clip: AnimationClip, scene: Pick<ProfileTestScene, 'face' | 'viseme' | 'hair' | 'head' | 'jaw' | 'body' | 'camera'>) {
  return {
    name: clip.name,
    duration: round(clip.duration),
    trackCount: clip.tracks.length,
    tracks: clip.tracks.map((track) => snapshotTrack(track, scene)),
  };
}

export function makeMixedBakedClip(scene: Pick<ProfileTestScene, 'face' | 'head' | 'body' | 'camera'>): AnimationClip {
  return new AnimationClip('MixedProfileTestBaked', 1, [
    new NumberKeyframeTrack(`${scene.face.uuid}.morphTargetInfluences[0]`, [0, 1], [0, 1]),
    new QuaternionKeyframeTrack(`${scene.head.uuid}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new NumberKeyframeTrack(`${scene.body.uuid}.position[x]`, [0, 1], [0, 1]),
    new NumberKeyframeTrack(`${scene.camera.uuid}.position[x]`, [0, 1], [0, 1]),
  ]);
}
