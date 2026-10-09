#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { assertNewReleaseDescendsFromPublished, readNpmMetadata, selectRelease } from './npm-release.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tags = execFileSync('git', ['tag', '--points-at', 'HEAD', '--list', 'v*'], {
  encoding: 'utf8',
}).trim().split('\n').filter(Boolean);
const metadata = await readNpmMetadata(pkg.name);
const release = selectRelease(metadata, pkg.version, sourceSha, tags);
if (!release.exists) {
  assertNewReleaseDescendsFromPublished(metadata, sourceSha, (ancestor, descendant) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'pipe' });
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw new Error('Cannot read the commit history needed to verify npm release order.', { cause: error });
    }
  });
}

// Store the source identity inside the tarball as well as in npm metadata.
// Do not run npm version lifecycle scripts or change the source checkout's tag.
pkg.version = release.version;
pkg.gitHead = sourceSha;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
if (existsSync('package-lock.json')) {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  lock.version = release.version;
  if (lock.packages?.['']) lock.packages[''].version = release.version;
  writeFileSync('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
}

const output = [
  `package_name=${pkg.name}`,
  `version=${release.version}`,
  `tag=v${release.version}`,
  `existing_version=${release.exists}`,
  `release_commit=${sourceSha}`,
].join('\n') + '\n';
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
else process.stdout.write(output);
