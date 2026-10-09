#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readNpmMetadata, shouldPublishRelease } from './npm-release.mjs';

const archive = process.argv[2];
if (!archive || process.argv.length !== 3) throw new Error('Pass exactly one verified npm package tarball.');
const pkg = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
if (pkg.version !== process.env.RELEASE_VERSION) throw new Error('Packed npm version differs from the verified release version.');
const metadata = await readNpmMetadata('@lovelace_lol/embody');
if (shouldPublishRelease(metadata, pkg, '@lovelace_lol/embody', process.env.RELEASE_COMMIT)) {
  // The tarball was packed from the checked build. Publication never rebuilds.
  execFileSync('npm', ['publish', archive, '--access', 'public', '--ignore-scripts', '--registry=https://registry.npmjs.org'], {
    stdio: 'inherit',
  });
} else {
  console.log(`${pkg.name}@${pkg.version} already identifies source ${pkg.gitHead}; publication skipped.`);
}
