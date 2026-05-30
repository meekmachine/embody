import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = await import('@lovelace_lol/embody');
const core = await import('@lovelace_lol/embody/core');
const three = await import('@lovelace_lol/embody/three');

const rootCjs = require('@lovelace_lol/embody');
const coreCjs = require('@lovelace_lol/embody/core');
const threeCjs = require('@lovelace_lol/embody/three');

const checks = [
  ['root Loom3 ESM', typeof root.Loom3 === 'function'],
  ['root Loom3 CJS', typeof rootCjs.Loom3 === 'function'],
  ['three Loom3 ESM', typeof three.Loom3 === 'function'],
  ['three Loom3 CJS', typeof threeCjs.Loom3 === 'function'],
  ['three inspector ESM', typeof three.ThreeModelInspector === 'function'],
  ['three applier CJS', typeof threeCjs.ThreeFrameApplier === 'function'],
  ['core ESM object', typeof core === 'object'],
  ['core CJS object', typeof coreCjs === 'object'],
];

const failures = checks.filter(([, passed]) => !passed);
if (failures.length > 0) {
  for (const [label] of failures) {
    console.error(`Package export smoke failed: ${label}`);
  }
  process.exit(1);
}

console.log('Package export smoke passed');
