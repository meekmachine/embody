import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = await import('@lovelace_lol/embody');
const core = await import('@lovelace_lol/embody/core');
const three = await import('@lovelace_lol/embody/three');

const rootCjs = require('@lovelace_lol/embody');
const coreCjs = require('@lovelace_lol/embody/core');
const threeCjs = require('@lovelace_lol/embody/three');

const checks = [
  ['root Embody ESM', typeof root.Embody === 'function'],
  ['root Embody CJS', typeof rootCjs.Embody === 'function'],
  ['three Embody ESM', typeof three.Embody === 'function'],
  ['three Embody CJS', typeof threeCjs.Embody === 'function'],
  ['three inspector ESM', typeof three.ThreeModelInspector === 'function'],
  ['three clip adapter ESM', typeof three.ThreeClipAdapter === 'function'],
  ['three applier CJS', typeof threeCjs.ThreeFrameApplier === 'function'],
  ['core compiler ESM', typeof core.TsClipCompiler === 'function'],
  ['core runtime ESM', typeof core.TsRuntimeCore === 'function'],
  ['root compiler CJS', typeof rootCjs.TsClipCompiler === 'function'],
  ['root runtime CJS', typeof rootCjs.TsRuntimeCore === 'function'],
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
