#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const exportPaths = Object.values(packageJson.exports).flatMap((entry) => {
  if (typeof entry === 'string') {
    return [entry];
  }
  return Object.values(entry).filter((path) => typeof path === 'string');
});
const requiredPaths = [...new Set([
  packageJson.main,
  packageJson.module,
  packageJson.types,
  ...exportPaths,
  './dist/wasm/embody_wasm.js',
  './dist/wasm/embody_wasm.d.ts',
  './dist/wasm/embody_wasm_bg.wasm',
])].filter(Boolean);

const failures = [];
for (const path of requiredPaths) {
  try {
    const metadata = await stat(resolve(path));
    if (!metadata.isFile() || metadata.size === 0) {
      failures.push(`${path} is not a non-empty file`);
    }
  } catch {
    failures.push(`${path} is missing`);
  }
}

try {
  const wasm = await readFile('dist/wasm/embody_wasm_bg.wasm');
  if (!wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
    failures.push('dist/wasm/embody_wasm_bg.wasm does not have a Wasm header');
  }
} catch {
  // The missing artifact is already reported above.
}

if (failures.length > 0) {
  console.error('Built package validation failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  console.error('Run `npm run build` once before validating or publishing.');
  process.exit(1);
}

console.log(`Built package validation passed (${requiredPaths.length} artifacts).`);
