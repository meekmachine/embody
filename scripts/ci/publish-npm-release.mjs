#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertPublicPackageStatus, readNpmMetadata } from './npm-release.mjs';
import { assertTrustedPublishingToolchain, formatPublicationReceipt, publishAndConfirm, readNpmVersion, runNpm } from './publication-receipt.mjs';

const publisher = { packageName: '@lovelace_lol/embody', repository: 'meekmachine/embody', workflow: 'pr-checks.yml' };
const summary = (content) => {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, content);
};
try {
  if (!process.argv[2] || process.argv.length !== 3) throw new Error('Pass exactly one verified npm package tarball.');
  const archive = resolve(process.argv[2]);
  const pkg = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  if (pkg.version !== process.env.RELEASE_VERSION) throw new Error('Packed npm version differs from the verified release version.');
  summary(`### Stable npm publication attempt\n\nPackage: \`${publisher.packageName}@${process.env.RELEASE_VERSION}\`\n\nVerified source: \`${process.env.RELEASE_COMMIT}\`\n\nThis is a stable npm attempt, separate from pkg.pr.new preview publication.\n`);
  assertTrustedPublishingToolchain(process.versions.node, runNpm(['--version'], publisher).trim());
  const status = JSON.parse(runNpm(['access', 'get', 'status', publisher.packageName, '--json', '--registry=https://registry.npmjs.org'], publisher));
  assertPublicPackageStatus(status, publisher.packageName);
  const integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
  const receipt = await publishAndConfirm({ pkg, archive, integrity, sourceSha: process.env.RELEASE_COMMIT,
    publisher, readMetadata: readNpmMetadata, readVersion: readNpmVersion, publish: (args) => runNpm(args, publisher) });
  const confirmation = formatPublicationReceipt(receipt);
  summary(confirmation);
  console.log(confirmation);
} catch (error) {
  summary(`### Stable npm publication NOT confirmed\n\n${error.message}\n\nA successful build or pkg.pr.new preview does not release a stable npm package. Fix this failure, then run this workflow on main with the ref input empty to retry stable publication.\n`);
  console.error(error.message);
  process.exitCode = 1;
}
