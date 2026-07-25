import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedPaths } from './classify-pr-checks.mjs';

const allChecks = {
  build: true,
  'rust-test': true,
  typecheck: true,
  test: true,
  'package-exports': true,
};

const noChecks = {
  build: false,
  'rust-test': false,
  typecheck: false,
  test: false,
  'package-exports': false,
};

test('docs-only changes skip expensive checks', () => {
  assert.deepEqual(
    classifyChangedPaths(['README.md', 'docs/ADAPTER_TARGETS.md']),
    noChecks,
  );
});

test('TypeScript and generated preset inputs run host package checks', () => {
  assert.deepEqual(
    classifyChangedPaths([
      'src/index.ts',
      'src/types/three-extensions.d.ts',
      'src/skeletonTemplates/data/jonathan-cc-base.json',
    ]),
    {
      ...allChecks,
      'rust-test': false,
    },
  );
});

test('Rust and Wasm inputs run build, Rust, and package export checks', () => {
  assert.deepEqual(
    classifyChangedPaths([
      'rust/embody-wasm/src/lib.rs',
      'rust/embody-wasm/assets/presets/cc4.json',
      'scripts/build-wasm.mjs',
    ]),
    {
      ...noChecks,
      build: true,
      'rust-test': true,
      'package-exports': true,
    },
  );
});

test('mixed TypeScript and Rust changes run every check', () => {
  assert.deepEqual(
    classifyChangedPaths(['src/index.ts', 'rust/embody-wasm/src/lib.rs']),
    allChecks,
  );
});

test('package metadata and classifier changes run every check', () => {
  assert.deepEqual(classifyChangedPaths(['package-lock.json']), allChecks);
  assert.deepEqual(
    classifyChangedPaths(['scripts/ci/classify-pr-checks.mjs']),
    allChecks,
  );
});

test('distribution and unknown future inputs fail open to every check', () => {
  assert.deepEqual(classifyChangedPaths(['dist/index.js']), allChecks);
  assert.deepEqual(classifyChangedPaths(['scripts/new-generator.mjs']), allChecks);
  assert.deepEqual(classifyChangedPaths(['new-build-input.toml']), allChecks);
  assert.deepEqual(classifyChangedPaths([]), allChecks);
});
