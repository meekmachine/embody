import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPack = resolve(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wasm-pack.cmd' : 'wasm-pack',
);
const rustc = execFileSync('rustup', ['which', 'rustc'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const toolchainBin = dirname(rustc);
const outDir = resolve(repoRoot, 'dist', 'wasm');

const result = spawnSync(
  existsSync(wasmPack) ? wasmPack : 'wasm-pack',
  [
    'build',
    'rust/embody-wasm',
    '--target',
    'web',
    '--out-dir',
    '../../dist/wasm',
    '--out-name',
    'embody_wasm',
    '--release',
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${toolchainBin}${delimiter}${process.env.PATH ?? ''}`,
      RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN ?? 'stable',
    },
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Remove files that would make dist/wasm look like a nested npm package.
await rm(resolve(outDir, 'package.json'), { force: true });
await rm(resolve(outDir, '.gitignore'), { force: true });

const requiredArtifacts = ['embody_wasm.js', 'embody_wasm_bg.wasm', 'embody_wasm.d.ts'];
for (const artifact of requiredArtifacts) {
  const artifactPath = resolve(outDir, artifact);
  if (!existsSync(artifactPath)) {
    throw new Error(`Missing required Wasm artifact: ${artifactPath}`);
  }
}
