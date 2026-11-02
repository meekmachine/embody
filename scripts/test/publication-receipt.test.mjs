import assert from 'node:assert/strict';
import { isAbsolute, relative } from 'node:path';
import test from 'node:test';
import { assertTrustedPublishingToolchain, formatPublicationReceipt, npmFailure, publishAndConfirm, readNpmPublicStatus, readNpmVersion } from '../ci/publication-receipt.mjs';

const publisher = { packageName: '@lovelace_lol/embody', repository: 'meekmachine/embody', workflow: 'pr-checks.yml' };
const sourceSha = 'b'.repeat(40);
const integrity = 'sha512-verified-archive';
const pkg = { name: publisher.packageName, version: '0.0.8', gitHead: sourceSha,
  repository: { url: `git+https://github.com/${publisher.repository}.git` },
  publishConfig: { access: 'public', provenance: false } };
const before = () => ({ name: pkg.name, versions: { '0.0.7': { name: pkg.name, version: '0.0.7', gitHead: 'a'.repeat(40) } } });
const record = () => ({ ...pkg, dist: { integrity } });
const archive = 'release-package/verified.tgz';
const options = () => ({ pkg, sourceSha, integrity, archive, publisher, readMetadata: async () => before() });

test('trusted publishing rejects unsupported npm even when Node is current', () => {
  for (const [node, npm] of [['22.14.0', '11.5.1'], ['24.0.0', '11.6.0']]) {
    assert.doesNotThrow(() => assertTrustedPublishingToolchain(node, npm));
  }
  for (const [node, npm] of [['22.13.0', '11.5.1'], ['24.0.0', '11.5.0'], ['24.0.0', 'invalid']]) {
    assert.throws(() => assertTrustedPublishingToolchain(node, npm), /trusted publishing requires/);
  }
});

test('exact-version reads are anonymous, bypass cached indexes and accept only 404 as absent', async () => {
  const found = await readNpmVersion(pkg.name, pkg.version, async (url, config) => {
    assert.equal(url, `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`);
    assert.deepEqual(config.headers, { accept: 'application/json', 'cache-control': 'no-cache' });
    assert.equal(config.redirect, 'error');
    return { ok: true, json: async () => record() };
  });
  assert.deepEqual(found, record());
  assert.equal(await readNpmVersion(pkg.name, pkg.version, async () => ({ status: 404, ok: false })), undefined);
  for (const status of [301, 401, 403, 429, 500]) {
    await assert.rejects(readNpmVersion(pkg.name, pkg.version, async () => ({ status, ok: false })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(readNpmVersion(pkg.name, pkg.version, async () => ({ ok: true, redirected: true })), /redirect/);
  await assert.rejects(readNpmVersion(pkg.name, pkg.version, async () => ({ ok: true, json: async () => ({ ...record(), version: '0.0.9' }) })), /different exact/);
  await assert.rejects(readNpmVersion(pkg.name, pkg.version, async () => { throw new Error('network unavailable'); }), /network unavailable/);
});

test('a fresh upload confirms its exact version even while the package index stays stale', async () => {
  let indexReads = 0;
  let versionReads = 0;
  let publications = 0;
  const receipt = await publishAndConfirm({ ...options(), readMetadata: async () => {
    indexReads += 1;
    return before(); // Deliberately never learns about the new version.
  }, readVersion: async (name, version) => {
    assert.equal(name, pkg.name);
    assert.equal(version, pkg.version);
    versionReads += 1;
    return versionReads === 1 ? undefined : record();
  }, publish: async (args) => {
    publications += 1;
    assert.equal(args[0], 'publish');
    assert.ok(isAbsolute(args[1]), 'npm must receive a local path rather than Git shorthand');
    assert.equal(relative(process.cwd(), args[1]), archive);
    assert.deepEqual(args.slice(2), ['--access', 'public', '--provenance=false', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
  } });
  assert.equal(publications, 1);
  assert.equal(indexReads, 1);
  assert.equal(versionReads, 2);
  assert.deepEqual(receipt, { package: pkg.name, version: pkg.version, sourceSha, integrity, status: 'published', archiveVerification: 'uploaded archive matches verified tarball' });
  const summary = formatPublicationReceipt(receipt);
  assert.match(summary, /Stable npm publication confirmed/);
  assert.ok(summary.includes(`${pkg.name}@${pkg.version}`));
  assert.ok(summary.includes(sourceSha));
  assert.ok(summary.includes(integrity));
  assert.match(summary, /does not establish production deployment/);
});

test('a stale index does not reupload an existing source even when rebuilding changes archive bytes', async () => {
  let versionReads = 0;
  const receipt = await publishAndConfirm({ ...options(), integrity: 'sha512-rebuilt-archive',
    readVersion: async () => { versionReads += 1; return record(); },
    publish: () => { throw new Error('immutable releases must not be uploaded again'); } });
  assert.equal(receipt.status, 'already-published');
  assert.equal(receipt.integrity, integrity, 'the receipt records the archive already in npm');
  assert.equal(receipt.archiveVerification, 'existing release identity confirmed; no upload');
  assert.equal(versionReads, 1);
});

test('a same-source release with different runtime dependencies cannot issue a receipt', async () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    await assert.rejects(publishAndConfirm({ ...options(),
      readVersion: async () => ({ ...record(), [field]: { unexpected: '1.0.0' } }),
      publish: () => { throw new Error('must not upload a conflicting immutable release'); } }), new RegExp(`different ${field}`));
  }
});

test('an uncertain exact-version lookup fails before uploading', async () => {
  await assert.rejects(publishAndConfirm({ ...options(),
    readVersion: async () => { throw new Error('HTTP 401'); },
    publish: () => { throw new Error('must not upload'); } }), /HTTP 401/);
  await assert.rejects(publishAndConfirm({ ...options(),
    readMetadata: async () => ({ ...before(), versions: { ...before().versions, [pkg.version]: record() } }),
    readVersion: async () => undefined,
    publish: () => { throw new Error('must not upload'); } }), /lookup disagree/);
});

test('a repository mismatch stops before registry reads or publication', async () => {
  await assert.rejects(publishAndConfirm({ ...options(), pkg: { ...pkg, repository: { url: 'git+https://github.com/someone/else.git' } },
    readMetadata: () => { throw new Error('unexpected metadata read'); },
    readVersion: () => { throw new Error('unexpected version read'); },
    publish: () => { throw new Error('unexpected publication'); } }), /repository.url/);
});

test('npm success without the exact registry version cannot produce a receipt or poll', async () => {
  let versionReads = 0;
  await assert.rejects(publishAndConfirm({ ...options(), readVersion: async () => { versionReads += 1; return undefined; },
    publish: async () => {} }), /expected stable source\/version is absent/);
  assert.equal(versionReads, 2);
});

test('a conflicting source or freshly uploaded archive fails confirmation', async () => {
  for (const conflict of [{ ...record(), gitHead: 'c'.repeat(40) }, { ...record(), dist: { integrity: 'sha512-different' } }]) {
    let versionReads = 0;
    await assert.rejects(publishAndConfirm({ ...options(), readVersion: async () => {
      versionReads += 1;
      return versionReads === 1 ? undefined : conflict;
    }, publish: async () => {} }), /another source|integrity does not match/);
  }
});

test('publication failure stops immediately without a confirmation lookup or receipt', async () => {
  let versionReads = 0;
  await assert.rejects(publishAndConfirm({ ...options(), readVersion: async () => { versionReads += 1; return undefined; },
    publish: () => { throw npmFailure({ stderr: 'npm error code EOTP\nAuthorization: Bearer private-token' }, publisher); } }), /EOTP/);
  assert.equal(versionReads, 1);
});

test('authentication diagnostics identify the configured trust without exposing npm output', () => {
  for (const code of ['EOTP', 'ENEEDAUTH', 'E401', 'E403', 'E404']) {
    const error = npmFailure({ stderr: `${code}: npm_secret-token Authorization: Bearer secret-id-token`, stdout: 'raw-private-output' }, publisher);
    assert.ok(error.message.includes(code));
    assert.ok(error.message.includes(publisher.repository));
    assert.ok(error.message.includes(publisher.workflow));
    assert.match(error.message, /Allow npm publish/);
    assert.match(error.message, /environment npm/);
    assert.doesNotMatch(error.message, /secret-token|secret-id-token|raw-private-output/);
  }
});

test('network and unknown npm failures do not prescribe changing publisher authentication', () => {
  for (const diagnostic of ['ENOTFOUND registry unavailable private-token', 'unclassified private-token']) {
    const error = npmFailure({ stderr: diagnostic }, publisher);
    assert.match(error.message, /registry availability, network access and release identity/);
    assert.doesNotMatch(error.message, /trusted publisher|Allow npm publish|private-token/);
  }
});

test('public visibility is confirmed anonymously without npm token configuration', async () => {
  const status = await readNpmPublicStatus(pkg.name, async (url, config) => {
    assert.equal(url, `https://registry.npmjs.org/-/package/${encodeURIComponent(pkg.name)}/visibility`);
    assert.deepEqual(config.headers, { accept: 'application/json' });
    assert.equal(config.redirect, 'error');
    return { ok: true, json: async () => ({ public: true }) };
  });
  assert.deepEqual(status, { [pkg.name]: 'public' });
  assert.deepEqual(await readNpmPublicStatus(pkg.name, async () => ({ ok: true, json: async () => ({ public: false }) })), { [pkg.name]: 'private' });
  for (const code of [401, 403, 404, 500]) {
    await assert.rejects(readNpmPublicStatus(pkg.name, async () => ({ ok: false, status: code })), new RegExp(`HTTP ${code}`));
  }
  await assert.rejects(readNpmPublicStatus(pkg.name, async () => ({ ok: true, redirected: true })), /redirect/);
  await assert.rejects(readNpmPublicStatus(pkg.name, async () => ({ ok: true, json: async () => ({}) })), /explicitly identify/);
});
