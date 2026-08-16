import { execFileSync } from 'node:child_process';

const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--ignore-scripts', '--json'],
  { encoding: 'utf8' },
);
const jsonStart = output.lastIndexOf('[\n  {');
if (jsonStart < 0) {
  throw new Error(`npm pack did not return package metadata:\n${output}`);
}

const [metadata] = JSON.parse(output.slice(jsonStart));
const files = new Set(metadata.files.map(({ path }) => path));
const requiredFiles = [
  'LICENSE',
  'README.md',
  'package.json',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/three/index.d.ts',
  'dist/three.js',
  'dist/wasm.js',
  'dist/wasm/embody_wasm.d.ts',
  'dist/wasm/embody_wasm.js',
  'dist/wasm/embody_wasm_bg.wasm',
  'dist/wasm/index.d.ts',
  'service-worker/character-asset-service-worker.js',
];
const missingFiles = requiredFiles.filter((path) => !files.has(path));
const forbiddenPrefixes = ['assets/', 'node_modules/', 'scripts/', 'src/', 'target/'];
const forbiddenFiles = [...files].filter(
  (path) =>
    ['Cargo.lock', 'Cargo.toml', 'build.rs'].includes(path) ||
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
);

if (missingFiles.length > 0 || forbiddenFiles.length > 0) {
  if (missingFiles.length > 0) {
    console.error(`Packed package is missing: ${missingFiles.join(', ')}`);
  }
  if (forbiddenFiles.length > 0) {
    console.error(`Packed package contains source/build inputs: ${forbiddenFiles.join(', ')}`);
  }
  process.exit(1);
}

console.log(`Packed package contents passed (${files.size} files).`);
