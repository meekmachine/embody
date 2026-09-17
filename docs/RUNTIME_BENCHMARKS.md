# Runtime boundary benchmark

This harness measures the CPU cost of commands crossing the JavaScript/Wasm
boundary and applying the result to Three objects. It compares flushing a full
frame after every setter with flushing once after all commands for a character.
It also checks that the two schedules produce the same deterministic poses.

## Run it

From a clean checkout, install locked dependencies and build the package once:

```sh
npm ci
npm run build
node scripts/bench/runtime-boundary.mjs > /tmp/embody-runtime-benchmark.json
```

The benchmark consumes the existing built package through its public ESM
exports. It never builds implicitly and needs no Loom3 checkout or character
assets. After changing runtime source, build that revision before measuring it.
`checkoutRevision` identifies the checkout, not a verified provenance stamp on
`dist/`; stale output produces a measurement of stale output.

For a shorter smoke run:

```sh
node scripts/bench/runtime-boundary.mjs --quick
```

Use the full run for comparisons. Keep the JSON reports outside the source tree.
Run each revision several times on the same machine, Node version, and power
settings with unrelated workloads paused. Compare sample ranges as well as
medians. A single run is not evidence of a small performance improvement.

## Workloads and units

| Workload | Included work | Reported unit |
| --- | --- | --- |
| Fresh-process startup | Import the public Wasm ESM entry and await initialization; read and instantiate the Wasm module | ms per initialization, excluding Node process launch |
| Idle frames | Tick the core, an empty Three mixer, active morph/bone evaluation and application, and world matrix update | ms per frame across all characters |
| Live frames | 1, 8, or 32 setters per character, full frame evaluation/application, and the idle tick work | ms per frame across all characters |
| Compilation | Parse pre-serialized input in Rust, compile a 32-track clip, serialize and parse its IR, and construct Three tracks | ms per clip |

Frame cases use both one and six independent characters. Each character has one
mesh, 64 one-to-one AU/morph mappings, and no bones or hair. Commands follow a
deterministic 96-frame cycle with zero and one endpoints. No random input is
used. Each frame's time is for **all** characters, not per character or per
setter. The fixed simulation step of 1/60 second does not pace execution or
assert that a browser can maintain 60 FPS.

The `per-setter` schedule evaluates and applies full morph, bone, and scene
frames after each setter, then performs the common tick. The `one-flush`
schedule performs that full write once per character with commands, then the
same tick. Full writes include scene JSON decoding and world matrix updates;
idle cases perform no full writes. Both include packed-array allocations made
by the current API. This deliberately isolates the cost of repeated boundary
work. It is not an implementation recommendation for ownership when live
controls overlap animated clips.

The script warms both schedules, alternates their measurement order, and
reports the median, minimum, maximum, and every sample. Each full frame sample
averages 500 consecutive frames; compilation samples average 30 clips. This
means the sample maximum is **not** a worst individual frame or a p99 latency.
Garbage collection and JIT work are neither suppressed nor measured separately.
Startup samples run in separate processes to avoid module and loader caches,
but can still benefit from the operating system's filesystem cache. They do
not represent a cold network load.

## Correctness checks

Before timing a frame case, the harness checks every frame in a complete
command cycle against the known one-to-one mapping, including untouched
channels and release-to-zero values. It compares both schedules and checks
both the applied Three pose and core AU state. It repeats final-pose checks
after every timing sample. Compilation checks deterministic track data,
expected endpoints, and playback through Three's real `AnimationMixer`.
Assertions run outside the measured sections and use a 1e-5 tolerance for
floating-point poses. Correctness failures cause a nonzero exit; elapsed times
have no pass/fail threshold.

These checks establish equivalence between two write schedules for this
fixture. They do **not** establish behavioral parity with the old TypeScript
runtime, validate transitions or inherited starts, or exercise ownership
conflicts between live controls and baked clips. Use dedicated regression
tests for those contracts. A new differential baseline must run the actual
legacy engine, not a simplified reimplementation that assumes its behavior.

## What remains to measure

This is a Node CPU diagnostic, not a browser rendering benchmark. It excludes
CLJS dispatch overhead, GPU work, realistic model hierarchies, skeletal motion,
speech/viseme scheduling, blink/gaze/hair interactions, and model download or
loading. The mixer used in frame timings has no active clips; the compilation
check exercises mixer playback separately, outside timing. Do not infer a
Rust-versus-TypeScript speedup or production frame rate from these results.

Use this harness to detect boundary work worth investigating. Before changing
host scheduling, validate live/clip ownership and immediate setter semantics.
Then measure real characters in the browser with combined speech, gaze, blink,
hair, baked animation, and multiple characters. Profile individual slow frames
and startup separately, and retain the browser, hardware, asset, and package
revision with every comparison.
