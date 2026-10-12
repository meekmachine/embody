import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyPackagePublication, packagePublication } from '../ci/package-publication.mjs';

const sourceSha = 'a'.repeat(40);
const stable = { channel: 'stable', sourceSha, packageVersion: '0.0.8' };

test('stable notifications identify the fixed upstream package and exact npm release', () => {
  assert.deepEqual(packagePublication(stable), {
    event_type: 'upstream-package-published',
    client_payload: {
      upstream_repo: 'meekmachine/embody', package_name: '@lovelace_lol/embody',
      channel: 'stable', source_sha: sourceSha, package_version: '0.0.8',
    },
  });
  for (const packageVersion of ['latest', '^0.0.8', '0.0.8-preview.1', undefined]) {
    assert.throws(() => packagePublication({ ...stable, packageVersion }), /exact npm version/);
  }
});

test('preview notifications bind a PR and immutable URL to the published checkout', () => {
  const { client_payload: payload } = packagePublication({ channel: 'preview', sourceSha, upstreamPr: '144' });
  assert.equal(payload.preview_url, `https://pkg.pr.new/meekmachine/embody/@lovelace_lol/embody@${sourceSha}`);
  assert.equal(payload.upstream_pr, 144);
  assert.equal(payload.package_version, undefined);
  assert.equal(packagePublication({ channel: 'preview', sourceSha }).client_payload.upstream_pr, null);
  for (const upstreamPr of [0, -1, '144x', '1.5', '01', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => packagePublication({ channel: 'preview', sourceSha, upstreamPr }), /positive integer/);
  }
  assert.throws(() => packagePublication({ ...stable, sourceSha: 'main' }), /full checked-out source SHA/);
  assert.throws(() => packagePublication({ ...stable, channel: 'production' }), /channel/);
});

test('notification credentials and destination cannot be supplied by publication data', async () => {
  let calls = 0;
  await notifyPackagePublication({ ...stable, upstream_repo: 'other/repo' }, 'dispatch-token', async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.github.com/repos/meekmachine/LoomLarge/dispatches');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer dispatch-token');
    assert.deepEqual(JSON.parse(options.body), packagePublication(stable));
    return { status: 204 };
  });
  assert.equal(calls, 1);
});

test('missing credentials and rejected notifications fail visibly without retries', async () => {
  let calls = 0;
  const send = async () => { calls += 1; return { status: 204 }; };
  for (const token of ['', ' ', 'bad\ntoken']) {
    await assert.rejects(notifyPackagePublication(stable, token, send), /CROSS_REPO_CI_TOKEN/);
  }
  assert.equal(calls, 0);
  for (const status of [301, 401, 403, 404, 429, 500]) {
    await assert.rejects(notifyPackagePublication(stable, 'dispatch-token', async () => ({ status })), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(notifyPackagePublication(stable, 'dispatch-token', async () => ({ status: 204, redirected: true })), /failed/);
  await assert.rejects(notifyPackagePublication(stable, 'dispatch-token', async () => { throw new Error('network unavailable'); }), /network/);
});
