#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { assertPublicPackageStatus, readNpmMetadata, shouldPublishRelease } from './npm-release.mjs';

if (!process.argv[2] || process.argv.length !== 3) throw new Error('Pass exactly one verified npm package tarball.');
// npm treats a bare directory/file argument as GitHub shorthand unless it is an explicit local path.
const archive = resolve(process.argv[2]);
const pkg = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
if (pkg.version !== process.env.RELEASE_VERSION) throw new Error('Packed npm version differs from the verified release version.');
// Keep the existing public package available without download credentials.
// Never change account/package visibility implicitly during a release.
const status = JSON.parse(execFileSync('npm', [
  'access', 'get', 'status', '@lovelace_lol/embody', '--json', '--registry=https://registry.npmjs.org',
], { encoding: 'utf8' }));
assertPublicPackageStatus(status, '@lovelace_lol/embody');
const metadata = await readNpmMetadata('@lovelace_lol/embody');
if (shouldPublishRelease(metadata, pkg, '@lovelace_lol/embody', process.env.RELEASE_COMMIT)) {
  // The tarball was packed from the checked build. Publication never rebuilds.
  execFileSync('npm', ['publish', archive, '--access', 'public', '--provenance=false', '--ignore-scripts', '--registry=https://registry.npmjs.org'], {
    stdio: 'inherit',
  });
} else {
  console.log(`${pkg.name}@${pkg.version} already identifies source ${pkg.gitHead}; publication skipped.`);
}
