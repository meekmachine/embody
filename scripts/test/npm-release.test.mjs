import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNewReleaseDescendsFromPublished, readNpmMetadata, selectRelease, shouldPublishRelease } from '../ci/npm-release.mjs';

const name = '@lovelace_lol/embody';
const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const metadata = (...entries) => ({
  name,
  versions: Object.fromEntries(entries.map(([version, gitHead]) => [version, { name, version, gitHead }])),
});
const old = () => metadata(['0.0.6', oldSha]);
const packed = (version = '0.0.7', gitHead = newSha) => ({
  name, version, gitHead, publishConfig: { access: 'restricted', provenance: false },
});
const readMetadata = (send) => readNpmMetadata(name, send, 'read-token');

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

test('restricted registry lookup authenticates only to the fixed npm origin and refuses redirects', async () => {
  const result = await readMetadata(async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/%40lovelace_lol%2Fembody');
    assert.equal(options.headers.accept, 'application/json');
    assert.equal(options.headers.authorization, 'Bearer read-token');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => old() };
  });
  assert.deepEqual(result, old());
  await assert.rejects(readNpmMetadata('https://another.example/path', async (url) => {
    assert.equal(new URL(url).origin, 'https://registry.npmjs.org');
    return { ok: false, status: 404 };
  }, 'read-token'), /HTTP 404/);
});

test('restricted metadata cannot fall back to anonymous access when a token is missing', async () => {
  let calls = 0;
  for (const token of ['', ' ', 'bad\ntoken']) {
    await assert.rejects(readNpmMetadata(name, async () => { calls += 1; }, token), /NODE_AUTH_TOKEN/);
  }
  assert.equal(calls, 0);
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

test('publishing never accepts a public package or public provenance configuration', () => {
  for (const publishConfig of [undefined, {}, { access: 'public', provenance: false },
    { access: 'restricted' }, { access: 'restricted', provenance: true }]) {
    assert.throws(() => shouldPublishRelease(old(), { ...packed(), publishConfig }, name, newSha), /restricted access/);
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
