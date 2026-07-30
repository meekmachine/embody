#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const outputPath = process.env.GITHUB_OUTPUT;

const currentVersion = pkg.version;
const releaseTag = execFileSync('git', ['tag', '--points-at', 'HEAD', '--list', 'v*'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean)[0];

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`Unsupported semver: ${version}`);
  }
  return match.slice(1).map(Number);
}

function compare(a, b) {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

function bumpPatch(version) {
  const [major, minor, patch] = parse(version);
  return `${major}.${minor}.${patch + 1}`;
}

let version;
let existingTag = 'false';
let publishedVersion = '';

if (releaseTag) {
  version = releaseTag.replace(/^v/, '');
  parse(version);
  existingTag = 'true';
} else {
  try {
    publishedVersion = execFileSync('npm', ['view', pkg.name, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_error) {
    publishedVersion = '';
  }

  const baseVersion =
    publishedVersion && compare(publishedVersion, currentVersion) > 0
      ? publishedVersion
      : currentVersion;
  version = bumpPatch(baseVersion);
}

execFileSync('npm', ['version', version, '--no-git-tag-version'], { stdio: 'inherit' });

const lines = [
  `package_name=${pkg.name}`,
  `version=${version}`,
  `tag=v${version}`,
  `existing_tag=${existingTag}`,
  `published_version=${publishedVersion}`,
  `release_commit=${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`,
];

const output = `${lines.join('\n')}\n`;
if (outputPath) {
  appendFileSync(outputPath, output);
} else {
  process.stdout.write(output);
}
