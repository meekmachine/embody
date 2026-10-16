import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Keep the temporary consumer beneath the repository so TypeScript resolves
// the package's peer dependency from this checkout's node_modules.
const workspace = await mkdtemp(join(root, '.package-declarations-'));
let neutralWorkspace;

try {
  const packOutput = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', workspace],
    { cwd: root, encoding: 'utf8' },
  );
  // npm may print lifecycle output before its JSON payload even when
  // --ignore-scripts is requested. Parse the final JSON array rather than
  // assuming stdout contains JSON alone.
  const jsonStart = packOutput.lastIndexOf('[\n  {');
  if (jsonStart < 0) {
    throw new Error(`npm pack did not return package metadata:\n${packOutput}`);
  }
  const [{ filename }] = JSON.parse(packOutput.slice(jsonStart));
  const archive = join(workspace, filename);

  execFileSync('tar', ['-xzf', archive, '-C', workspace]);

  // Resolve the consumer's imports through the real package exports rather
  // than reaching into its declarations with repository-relative paths.
  const packageRoot = join(workspace, 'node_modules', '@lovelace_lol', 'embody');
  await mkdir(dirname(packageRoot), { recursive: true });
  await rename(join(workspace, 'package'), packageRoot);
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  assert.equal(packageJson.peerDependenciesMeta?.three?.optional, true,
    'Wasm-only consumers must not be required to install Three.');
  const declarationEntries = [...new Set([
    ...Object.values(packageJson.exports)
      .filter((entry) => entry && typeof entry === 'object' && entry.types)
      .map((entry) => join(packageRoot, entry.types)),
    join(packageRoot, 'dist', 'wasm.d.ts'),
  ])];

  if (declarationEntries.length === 0) {
    throw new Error('Packed Embody package does not declare any typed exports.');
  }

  const consumer = join(workspace, 'wasm-consumer.mts');
  await copyFile(join(root, 'scripts', 'fixtures', 'wasm-consumer.mts'), consumer);
  const consumerConfig = join(workspace, 'tsconfig.json');
  await writeFile(consumerConfig, JSON.stringify({
    compilerOptions: {
      noEmit: true,
      strict: true,
      skipLibCheck: false,
      moduleResolution: 'bundler',
      module: 'esnext',
      target: 'es2022',
      // Browser consumers must not rely on @types/node to supply Symbol.dispose
      // or any other ambient declarations needed by the generated Wasm types.
      types: [],
    },
    files: [...declarationEntries, consumer],
  }, null, 2));

  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [tsc, '--project', consumerConfig],
    { cwd: root, stdio: 'inherit' },
  );

  // Separate from the checkout's node_modules: the neutral declaration graph
  // and runtime import must work without inheriting Three from this repository.
  neutralWorkspace = await mkdtemp(join(tmpdir(), 'embody-wasm-consumer-'));
  const neutralPackageRoot = join(neutralWorkspace, 'node_modules', '@lovelace_lol', 'embody');
  await mkdir(dirname(neutralPackageRoot), { recursive: true });
  await cp(packageRoot, neutralPackageRoot, { recursive: true });
  for (const extension of ['mts', 'mjs']) {
    await copyFile(join(root, 'scripts', 'fixtures', `wasm-only-consumer.${extension}`),
      join(neutralWorkspace, `wasm-only-consumer.${extension}`));
  }
  const neutralConfig = join(neutralWorkspace, 'tsconfig.json');
  await writeFile(neutralConfig, JSON.stringify({
    compilerOptions: {
      noEmit: true, strict: true, skipLibCheck: false, moduleResolution: 'bundler',
      module: 'esnext', target: 'es2022', types: [],
    },
    files: [join(neutralWorkspace, 'wasm-only-consumer.mts')],
  }, null, 2));
  execFileSync(process.execPath, [tsc, '--project', neutralConfig],
    { cwd: neutralWorkspace, stdio: 'inherit' });
  execFileSync(process.execPath, [join(neutralWorkspace, 'wasm-only-consumer.mjs')],
    { cwd: neutralWorkspace, stdio: 'inherit' });

  console.log(
    `Packed declaration contract passed (${declarationEntries.length} entrypoints, compatible Three types, and a Wasm-only consumer).`,
  );
} finally {
  if (neutralWorkspace) await rm(neutralWorkspace, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
}
