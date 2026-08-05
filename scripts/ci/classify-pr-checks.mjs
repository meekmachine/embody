import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CHECK_NAMES = [
  'build',
  'rust-test',
  'typecheck',
  'test',
  'package-exports',
];

const DOCUMENTATION_PATHS = [
  /^(?:[^/]+\.md|docs\/|assets\/readme\/)/,
  /^\.github\/CODEOWNERS$/,
  /^\.gitattributes$/,
  /^\.gitignore$/,
];

const RUST_PATHS = [
  /^src\//,
  /^assets\/(?:presets|templates)\//,
  /^Cargo\.(?:toml|lock)$/,
  /^build\.rs$/,
  /^scripts\/build-wasm\.mjs$/,
];

const TYPESCRIPT_PATHS = [
  /^index\.ts$/,
  /^three\//,
  /^wasm\//,
  /^scripts\/extract-humanoid-skeleton-template\.cjs$/,
  /^scripts\/smoke\//,
  /^tsconfig(?:\.[^/]+)?\.json$/,
  /^tsup(?:\.[^/]+)?\.mjs$/,
];

const FORCE_ALL_PATHS = [
  /^\.github\/workflows\/pr-checks\.yml$/,
  /^scripts\/ci\/classify-pr-checks(?:\.test)?\.mjs$/,
  /^package(?:-lock)?\.json$/,
];

function emptySelection() {
  return Object.fromEntries(CHECK_NAMES.map((name) => [name, false]));
}

function enableAll(selection) {
  for (const name of CHECK_NAMES) {
    selection[name] = true;
  }
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.test(path));
}

export function classifyChangedPaths(paths) {
  const selection = emptySelection();
  const normalizedPaths = paths.map((path) => path.trim()).filter(Boolean);

  // An empty or unrecognized change set is unsafe to skip, so run everything.
  if (normalizedPaths.length === 0) {
    enableAll(selection);
    return selection;
  }

  for (const path of normalizedPaths) {
    if (matchesAny(path, DOCUMENTATION_PATHS)) {
      continue;
    }

    if (matchesAny(path, FORCE_ALL_PATHS)) {
      enableAll(selection);
      return selection;
    }

    if (matchesAny(path, RUST_PATHS)) {
      selection.build = true;
      selection['rust-test'] = true;
      selection['package-exports'] = true;
      continue;
    }

    if (matchesAny(path, TYPESCRIPT_PATHS)) {
      selection.build = true;
      selection.typecheck = true;
      selection.test = true;
      selection['package-exports'] = true;
      continue;
    }

    // Distribution files, declarations outside the adapter, new build inputs, and any
    // future path category default to all checks until deliberately classified.
    enableAll(selection);
    return selection;
  }

  return selection;
}

function changedPaths(baseSha, headSha) {
  return execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMRTUXB', `${baseSha}...${headSha}`],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean);
}

function writeGitHubOutputs(selection, outputPath) {
  const output = Object.entries(selection)
    .map(([name, enabled]) => `${name}=${enabled}`)
    .join('\n');

  appendFileSync(outputPath, `${output}\n`);
}

function main() {
  const { BASE_SHA: baseSha, HEAD_SHA: headSha, GITHUB_OUTPUT: outputPath } =
    process.env;

  if (!baseSha || !headSha || !outputPath) {
    throw new Error('BASE_SHA, HEAD_SHA, and GITHUB_OUTPUT are required');
  }

  const paths = changedPaths(baseSha, headSha);
  const selection = classifyChangedPaths(paths);

  writeGitHubOutputs(selection, outputPath);
  console.log(JSON.stringify({ paths, checks: selection }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
