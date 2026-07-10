import { performance } from 'node:perf_hooks';
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  Object3D,
} from 'three';
import { Loom3 } from '../../dist/index.js';

const MORPHS = [
  'BrowUp_L',
  'BrowUp_R',
  'BrowCenter',
  'Smile',
  'LookLeft',
  'LookRight',
  'RuntimeSmile',
  'Mouth_Aah',
  'Mouth_Wide',
  'Shared_Mouth',
];

function makeMorphGeometry(morphKeys) {
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
  geometry.morphAttributes.position = morphKeys.map((key, index) => {
    const attribute = new BufferAttribute(new Float32Array(9).fill((index + 1) / 100), 3);
    attribute.name = key;
    return attribute;
  });
  geometry.morphTargetsRelative = true;
  return geometry;
}

function makeMesh(name, morphKeys) {
  const mesh = new Mesh(makeMorphGeometry(morphKeys), new MeshBasicMaterial());
  mesh.name = name;
  mesh.morphTargetDictionary = Object.fromEntries(morphKeys.map((key, index) => [key, index]));
  mesh.morphTargetInfluences = new Array(morphKeys.length).fill(0);
  return mesh;
}

function makeProfile() {
  return {
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
    },
    boneNodes: {
      HEAD: 'Head',
      JAW: 'Jaw',
    },
    morphToMesh: {
      face: ['FaceMesh'],
      viseme: ['FaceMesh'],
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
        pitch: { aus: [26], axis: 'rz' },
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
  };
}

function makeScene() {
  const model = new Object3D();
  const head = new Object3D();
  head.name = 'Head';
  const jaw = new Object3D();
  jaw.name = 'Jaw';
  const face = makeMesh('FaceMesh', MORPHS);
  model.add(head, jaw, face);
  const engine = new Loom3({ profile: makeProfile() });
  engine.onReady({ model, meshes: [face] });
  return engine;
}

function bench(label, iterations, run) {
  const start = performance.now();
  run();
  const elapsedMs = performance.now() - start;
  const opsPerSecond = iterations / (elapsedMs / 1000);
  console.log(`${label}: ${elapsedMs.toFixed(2)}ms, ${Math.round(opsPerSecond).toLocaleString()} ops/sec`);
}

function withoutLoomLogs(run) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    run();
  } finally {
    console.log = originalLog;
  }
}

const iterations = Number(process.env.EMBODY_BENCH_ITERATIONS ?? 10_000);
const engine = makeScene();

bench('setAU balanced morph+bone', iterations, () => {
  for (let i = 0; i < iterations; i += 1) {
    engine.setAU(1, (i % 100) / 100, i % 2 === 0 ? -0.4 : 0.4);
    engine.setContinuum(30, 31, ((i % 200) - 100) / 100);
    engine.update(1 / 60);
  }
});

bench('setViseme weighted morph+jaw', iterations, () => {
  for (let i = 0; i < iterations; i += 1) {
    engine.setVisemeById('aa', (i % 100) / 100);
    engine.setVisemeById('bmp', ((i + 50) % 100) / 100);
    engine.update(1 / 60);
  }
});

bench('snippetToClip AU+bone', Math.max(1, Math.floor(iterations / 100)), () => {
  withoutLoomLogs(() => {
    for (let i = 0; i < Math.max(1, Math.floor(iterations / 100)); i += 1) {
      engine.snippetToClip(`bench-${i}`, {
        '1': [
          { time: 0, intensity: 0 },
          { time: 0.5, intensity: 1 },
        ],
        '30': [
          { time: 0, intensity: 0 },
          { time: 0.5, intensity: 0.5 },
        ],
      }, { balance: -0.25 });
    }
  });
});
