import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Keep the temporary consumer beneath the repository so TypeScript resolves
// the package's peer dependency from this checkout's node_modules.
const workspace = await mkdtemp(join(root, '.package-declarations-'));

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

  const packageRoot = join(workspace, 'package');
  const packageJson = JSON.parse(
    await readFile(join(packageRoot, 'package.json'), 'utf8'),
  );
  const declarationEntries = [...new Set(
    Object.values(packageJson.exports)
      .filter((entry) => entry && typeof entry === 'object' && entry.types)
      .map((entry) => join(packageRoot, entry.types)),
  )];

  if (declarationEntries.length === 0) {
    throw new Error('Packed Embody package does not declare any typed exports.');
  }

  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(
    process.execPath,
    [
      tsc,
      '--noEmit',
      '--skipLibCheck',
      'false',
      '--moduleResolution',
      'bundler',
      '--module',
      'esnext',
      '--target',
      'es2022',
      ...declarationEntries,
    ],
    { cwd: root, stdio: 'inherit' },
  );

  console.log(
    `Packed declaration contract passed (${declarationEntries.length} entrypoints).`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
