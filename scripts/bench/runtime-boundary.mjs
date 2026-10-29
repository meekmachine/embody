import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  quick: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: node scripts/bench/runtime-boundary.mjs [--quick]\n'
    + 'Requires npm ci && npm run build. Writes a JSON report to stdout.\n'
    + '--quick: short correctness/smoke run; timings are especially noisy.\n'
    + 'See docs/RUNTIME_BENCHMARKS.md for methodology and limitations.');
  process.exit(0);
}

const root = new URL('../../', import.meta.url);
for (const artifact of ['dist/wasm.js', 'dist/three.js', 'dist/wasm/embody_wasm_bg.wasm']) {
  if (!existsSync(new URL(artifact, root))) {
    throw new Error(`Missing ${artifact}. Run npm ci and npm run build before benchmarking.`);
  }
}
const settings = values.quick
  ? { samples: 3, warmupFrames: 10, framesPerSample: 30, startupSamples: 2, compileIterations: 3 }
  : { samples: 7, warmupFrames: 100, framesPerSample: 500, startupSamples: 5, compileIterations: 30 };
const { initEmbodyCore } = await import('@lovelace_lol/embody/wasm');
const { createAnimationClipFromClipIR } = await import('@lovelace_lol/embody/three');
const THREE = await import('three');
const {
  createCharacter, createCurves, controlValue, runFrame, MORPH_COUNT, FIRST_AU,
} = await import('./fixture.mjs');
const wasm = await initEmbodyCore();

function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median, min: sorted[0], max: sorted.at(-1), samples };
}

function near(actual, expected, label) {
  assert(Number.isFinite(actual), `${label}: output must be finite, received ${actual}`);
  assert(Math.abs(actual - expected) <= 1e-5, `${label}: expected ${expected}, received ${actual}`);
}

function checkPose(characters, activeControls, frame) {
  characters.forEach((character, characterIndex) => {
    for (let control = 0; control < MORPH_COUNT; control += 1) {
      const expected = control < activeControls ? controlValue(frame, control, characterIndex) : 0;
      near(character.mesh.morphTargetInfluences[control], expected, `character ${characterIndex}, morph ${control}`);
      near(character.core.get_au(FIRST_AU + control), expected, `character ${characterIndex}, AU ${control}`);
    }
  });
}

function comparePoses(left, right) {
  left.forEach((character, index) => character.mesh.morphTargetInfluences.forEach((value, morph) => {
    near(value, right[index].mesh.morphTargetInfluences[morph], `batch equivalence, character ${index}, morph ${morph}`);
  }));
}

const modes = ['per-setter', 'one-flush'];
function benchmarkFrames(characterCount, activeControls) {
  const characters = modes.map(() => Array.from({ length: characterCount }, () => createCharacter(wasm)));
  const samples = modes.map(() => []);
  try {
    // Assert each frame in a complete deterministic command cycle, including
    // zero releases. This catches transient errors hidden by final-pose checks.
    for (let frame = 0; frame < 96; frame += 1) {
      modes.forEach((mode, index) => {
        runFrame(characters[index], activeControls, mode, frame);
        checkPose(characters[index], activeControls, frame);
      });
      comparePoses(...characters);
    }
    modes.forEach((mode, index) => {
      for (let frame = 0; frame < settings.warmupFrames; frame += 1) {
        runFrame(characters[index], activeControls, mode, frame);
      }
    });
    for (let sample = 0; sample < settings.samples; sample += 1) {
      // Alternate measurement order to reduce systematic first/second bias.
      for (const index of sample % 2 ? [1, 0] : [0, 1]) {
        const firstFrame = settings.warmupFrames + sample * settings.framesPerSample;
        const started = performance.now();
        for (let frame = firstFrame; frame < firstFrame + settings.framesPerSample; frame += 1) {
          runFrame(characters[index], activeControls, modes[index], frame);
        }
        samples[index].push((performance.now() - started) / settings.framesPerSample);
        checkPose(characters[index], activeControls, firstFrame + settings.framesPerSample - 1);
      }
      comparePoses(...characters);
    }
    return {
      characterCount,
      activeControlsPerCharacter: activeControls,
      unit: 'milliseconds per frame for all characters',
      perSetter: distribution(samples[0]),
      oneFlush: distribution(samples[1]),
    };
  } finally {
    characters.flat().forEach((character) => character.dispose());
  }
}

function benchmarkCompilation() {
  const character = createCharacter(wasm);
  const curves = createCurves();
  const curvesJson = JSON.stringify(curves);
  const compile = () => {
    // Reuse the name so RuntimeCore replaces one clip rather than accumulating
    // a registry whose size grows with the number of benchmark iterations.
    const ir = JSON.parse(character.core.build_clip('benchmark', curvesJson, '{}'));
    return createAnimationClipFromClipIR(ir, character.inspection);
  };
  try {
    const reference = compile();
    assert.equal(reference.tracks.length, 32);
    near(reference.duration, 1, 'compiled clip duration');
    for (const [control, points] of Object.entries(curves)) {
      const index = Number(control) - FIRST_AU;
      const track = reference.tracks.find((candidate) => candidate.name.endsWith(`morphTargetInfluences[${index}]`));
      assert(track, `missing compiled track ${control}`);
      near(track.values[0], points[0].intensity, `compiled start ${control}`);
      near(track.values.at(-1), points.at(-1).intensity, `compiled end ${control}`);
    }
    // Use Three's real property binding and mixer to check compiled endpoints.
    const action = character.mixer.clipAction(reference).setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    character.mixer.update(1);
    for (const [control, points] of Object.entries(curves)) {
      near(character.mesh.morphTargetInfluences[Number(control) - FIRST_AU], points.at(-1).intensity, `mixer endpoint ${control}`);
    }
    for (let index = 0; index < 5; index += 1) compile();
    const samples = [];
    for (let sample = 0; sample < settings.samples; sample += 1) {
      let clip;
      const started = performance.now();
      for (let index = 0; index < settings.compileIterations; index += 1) clip = compile();
      samples.push((performance.now() - started) / settings.compileIterations);
      assert.equal(clip.tracks.length, reference.tracks.length);
      clip.tracks.forEach((track, index) => {
        assert.deepEqual(track.times, reference.tracks[index].times);
        assert.deepEqual(track.values, reference.tracks[index].values);
      });
    }
    return {
      tracks: 32, inputPointsPerTrack: 5,
      unit: 'milliseconds per compile, JSON decode, and Three clip conversion',
      timing: distribution(samples),
    };
  } finally {
    character.dispose();
  }
}

const startupSamples = [];
for (let sample = 0; sample < settings.startupSamples; sample += 1) {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./startup-child.mjs', import.meta.url))], { encoding: 'utf8' });
  const { importAndInitializeMs } = JSON.parse(output);
  assert(Number.isFinite(importAndInitializeMs) && importAndInitializeMs >= 0);
  startupSamples.push(importAndInitializeMs);
}
const frameWorkloads = [];
for (const characterCount of [1, 6]) {
  for (const activeControls of [0, 1, 8, 32]) {
    frameWorkloads.push(benchmarkFrames(characterCount, activeControls));
  }
}
let revision = null;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {
  // The script also works from source archives without Git metadata.
}
console.log(JSON.stringify({
  schemaVersion: 1,
  environment: {
    node: process.version, platform: process.platform, arch: process.arch,
    osRelease: release(), cpu: cpus()[0]?.model ?? null, threeRevision: THREE.REVISION,
    packageVersion: JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version,
    checkoutRevision: revision, measuredAt: new Date().toISOString(),
  },
  settings,
  conformance: 'passed: deterministic poses, batching equivalence, compiled tracks, and Three mixer endpoints',
  fixture: { morphsPerCharacter: MORPH_COUNT, meshesPerCharacter: 1, bones: 0, hair: false, rendering: false },
  startup: {
    unit: 'milliseconds for ESM import and Wasm initialization in a fresh Node process; excludes process launch',
    timing: distribution(startupSamples),
  },
  frameWorkloads,
  compilation: benchmarkCompilation(),
}, null, 2));
