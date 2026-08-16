#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const generatedPaths = [
  {
    label: 'distribution output',
    matches: (path) => path === 'dist' || path.startsWith('dist/'),
  },
  {
    label: 'Rust build output',
    matches: (path) => /(^|\/)target\//.test(path),
  },
  {
    label: 'installed dependencies',
    matches: (path) => /(^|\/)node_modules\//.test(path),
  },
  {
    label: 'compiled Wasm',
    matches: (path) => path.endsWith('.wasm'),
  },
  {
    label: 'packed npm archive',
    matches: (path) => path.endsWith('.tgz'),
  },
  {
    label: 'local generated metadata',
    matches: (path) =>
      path === '.DS_Store' ||
      path.endsWith('/.DS_Store') ||
      /(^|\/)\.package-declarations-[^/]+/.test(path),
  },
];

const trackedPaths = execFileSync('git', ['ls-files', '-z'], {
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
  .sort();

const violations = trackedPaths.flatMap((path) =>
  generatedPaths
    .filter(({ matches }) => matches(path))
    .map(({ label }) => ({ label, path })),
);

if (violations.length > 0) {
  console.error('Generated output must not be committed:');
  for (const { label, path } of violations) {
    console.error(`- ${path} (${label})`);
  }
  console.error('Remove these paths from Git; CI and package previews build them from source.');
  process.exit(1);
}

console.log(`Tracked-source guard passed (${trackedPaths.length} files checked).`);
