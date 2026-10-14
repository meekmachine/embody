import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, relative } from 'node:path';
import { assertNewReleaseDescendsFromPublished, assertPublicPackageStatus, readNpmMetadata, selectRelease, shouldPublishRelease } from '../ci/npm-release.mjs';

const name = '@lovelace_lol/embody';
const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const metadata = (...entries) => ({
  name,
  versions: Object.fromEntries(entries.map(([version, gitHead]) => [version, { name, version, gitHead }])),
});
const old = () => metadata(['0.0.6', oldSha]);
const packed = (version = '0.0.7', gitHead = newSha) => ({
  name, version, gitHead, publishConfig: { access: 'public', provenance: false },
});
const readMetadata = (send) => readNpmMetadata(name, send);

test('the publishing entry point passes the verified tarball to npm as a local file', async (t) => {
  const previousArgv = process.argv;
  const previousEnvironment = { RELEASE_VERSION: process.env.RELEASE_VERSION, RELEASE_COMMIT: process.env.RELEASE_COMMIT };
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    process.argv = previousArgv;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const archive = 'release-package/lovelace_lol-embody-0.0.7.tgz';
  process.argv = [process.execPath, 'publish-npm-release.mjs', archive];
  process.env.RELEASE_VERSION = '0.0.7';
  process.env.RELEASE_COMMIT = newSha;
  let verifiedArchive;
  let publications = 0;
  t.mock.method(childProcess, 'execFileSync', (command, args) => {
    if (command === 'tar') {
      verifiedArchive = args[1];
      return JSON.stringify(packed());
    }
    if (command === 'npm' && args[0] === 'access') return JSON.stringify({ [name]: 'public' });
    assert.equal(command, 'npm');
    assert.equal(args[0], 'publish');
    assert.ok(isAbsolute(args[1]), 'npm must receive an explicit local file, not owner/repo shorthand');
    assert.equal(relative(process.cwd(), args[1]), archive);
    assert.equal(args[1], verifiedArchive);
    assert.ok(args.includes('--ignore-scripts'));
    publications += 1;
  });
  syncBuiltinESMExports();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => old() }));
  await import('../ci/publish-npm-release.mjs');
  assert.equal(publications, 1);
});

test('new main commit advances the highest stable version, independent of latest tag', () => {
  const published = metadata(['0.0.6', oldSha], ['0.0.8', 'c'.repeat(40)], ['1.0.0-beta.1', oldSha]);
  published['dist-tags'] = { latest: '0.0.6' };
  assert.deepEqual(selectRelease(published, '0.0.0', newSha), { version: '0.0.9', exists: false });
  assert.deepEqual(selectRelease(old(), '1.0.0', newSha), { version: '1.0.1', exists: false });
});

test('rerun reuses the exact npm version published from this commit', () => {
  assert.deepEqual(selectRelease(metadata(['0.0.6', oldSha], ['0.0.7', newSha]), '0.0.0', newSha), {
    version: '0.0.7', exists: true,
  });
});

test('an unpublished reserved tag is reused but cannot overwrite another source', () => {
  assert.deepEqual(selectRelease(old(), '0.0.0', newSha, ['v0.0.7']), { version: '0.0.7', exists: false });
  assert.throws(() => selectRelease(old(), '0.0.0', newSha, ['v0.0.6']), /another source/);
  assert.throws(() => selectRelease(old(), '0.0.0', newSha, ['v0.0.5']), /behind/);
});

test('conflicting tags and source identities require investigation', () => {
  assert.throws(() => selectRelease(metadata(['0.0.6', newSha], ['0.0.7', newSha]), '0.0.0', newSha), /Multiple npm/);
  assert.throws(() => selectRelease(old(), '0.0.0', newSha, ['v0.0.7', 'v0.0.8']), /multiple stable/);
  assert.throws(() => selectRelease(metadata(['0.0.7', newSha]), '0.0.0', newSha, ['v0.0.8']), /disagrees/);
  assert.throws(() => selectRelease(old(), '0.0.0', 'main'), /full source/);
});

test('registry errors never become a new package or a reset version', async () => {
  for (const status of [301, 302, 307, 401, 403, 404, 429, 500]) {
    await assert.rejects(readMetadata(async () => ({ ok: false, status })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(readMetadata(async () => { throw new Error('network unavailable'); }), /network/);
  await assert.rejects(readMetadata(async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } })), /invalid JSON/);
  await assert.rejects(readMetadata(async () => ({ ok: true, json: async () => ({ name }) })), /version records/);
  await assert.rejects(readMetadata(async () => ({ ok: true, json: async () => ({ name, versions: {} }) })), /no stable/);
  await assert.rejects(readMetadata(async () => ({ ok: true, json: async () => ({ ...old(), name: 'another-package' }) })), /different package/);
  await assert.rejects(readMetadata(async () => ({ ok: true, json: async () => ({ name, versions: { '0.0.6': {} } }) })), /invalid metadata/);
  await assert.rejects(readMetadata(async () => ({ ok: true, redirected: true, json: async () => old() })), /redirects/);
});

test('public registry metadata uses the fixed npm origin without credentials and refuses redirects', async () => {
  const result = await readMetadata(async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40lovelace_lol%2Fembody');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => old() };
  });
  assert.deepEqual(result, old());
  await assert.rejects(readNpmMetadata('https://another.example/path', async (url) => {
    assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
    return { ok: false, status: 404 };
  }), /HTTP 404/);
});

test('metadata reads work without a token and never transmit an ambient publishing token', async () => {
  const originalToken = process.env.NODE_AUTH_TOKEN;
  let calls = 0;
  try {
    for (const token of [undefined, 'publisher-token']) {
      if (token === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = token;
      await readMetadata(async (_url, options) => {
        calls += 1;
        assert.deepEqual(options.headers, { accept: 'application/json' });
        return { ok: true, json: async () => old() };
      });
    }
  } finally {
    if (originalToken === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = originalToken;
  }
  assert.equal(calls, 2);
});

test('publish consumes the expected source and skips only an identical published source', () => {
  assert.equal(shouldPublishRelease(old(), packed(), name, newSha), true);
  assert.equal(shouldPublishRelease(metadata(['0.0.7', newSha]), packed(), name, newSha), false);
  assert.throws(() => shouldPublishRelease(old(), packed('0.0.6'), name, newSha), /another source/);
  assert.throws(() => shouldPublishRelease(old(), packed('0.0.7', oldSha), name, newSha), /does not match/);
  assert.throws(() => shouldPublishRelease(old(), { ...packed(), name: 'unexpected' }, name, newSha), /does not match/);
  assert.throws(() => shouldPublishRelease(old(), packed(), name, undefined), /does not match/);
  assert.throws(() => shouldPublishRelease(old(), packed('0.0.7-beta.1'), name, newSha), /exact stable/);
});

test('publishing requires public access without private-repository provenance', () => {
  for (const publishConfig of [undefined, {}, { access: 'restricted', provenance: false },
    { access: 'public' }, { access: 'public', provenance: true }]) {
    assert.throws(() => shouldPublishRelease(old(), { ...packed(), publishConfig }, name, newSha), /public access/);
  }
});

test('publication requires npm to confirm public visibility for the exact package', () => {
  assertPublicPackageStatus({ [name]: 'public' }, name);
  for (const status of [null, 'public', {}, [], { [name]: 'private' },
    { [name]: 'restricted' }, { another: 'public' }, { [name]: 'public', another: 'public' }]) {
    assert.throws(() => assertPublicPackageStatus(status, name), /must report.*public/);
  }
});

test('a version published between preparation and publication cannot be replaced', () => {
  assert.throws(() => shouldPublishRelease(metadata(['0.0.8', oldSha]), packed(), name, newSha), /behind/);
  assert.throws(() => shouldPublishRelease(metadata(['0.0.6', newSha]), packed(), name, newSha), /another npm version/);
});

test('retrying an older unpublished main commit cannot make it the newest release', () => {
  assert.throws(() => assertNewReleaseDescendsFromPublished(old(), newSha, () => false), /refusing an older/);
  assertNewReleaseDescendsFromPublished(old(), newSha, (ancestor, descendant) => {
    assert.equal(ancestor, oldSha);
    assert.equal(descendant, newSha);
    return true;
  });
  assert.throws(() => assertNewReleaseDescendsFromPublished(metadata(['0.0.6', undefined]), newSha, () => true), /full gitHead/);
  assert.throws(() => assertNewReleaseDescendsFromPublished(old(), newSha, () => { throw new Error('history unavailable'); }), /history unavailable/);
});
