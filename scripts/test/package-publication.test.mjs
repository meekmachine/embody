import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyPackagePublication, packagePublication, validatePublicationRecord } from '../ci/package-publication.mjs';

const sourceSha = 'a'.repeat(40);
const stable = { channel: 'stable', sourceSha, packageVersion: '0.0.8' };
const repository = { full_name: 'meekmachine/embody' };
const completedRun = (overrides = {}) => ({
  id: 100, run_attempt: 2, path: '.github/workflows/pr-checks.yml',
  repository, head_repository: repository, status: 'completed', conclusion: 'success',
  event: 'push', head_branch: 'main', head_sha: sourceSha, pull_requests: [], ...overrides,
});
const record = (input = stable) => ({ run_id: 100, run_attempt: 2, publication: packagePublication(input) });
const preview = { channel: 'preview', sourceSha, upstreamPr: 144 };
const prRun = (overrides = {}) => completedRun({
  event: 'pull_request', head_branch: 'feature', pull_requests: [{ number: 144 }], ...overrides,
});
const currentPr = (overrides = {}) => ({
  number: 144, state: 'open', head: { sha: sourceSha, repo: repository },
  base: { ref: 'main', repo: repository }, ...overrides,
});

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

test('the receiver accepts only the completed main source for stable notifications', () => {
  assert.deepEqual(validatePublicationRecord(record(), completedRun()), { ...stable, upstreamPr: undefined });
  validatePublicationRecord(record(), completedRun({ event: 'workflow_dispatch' }));
  for (const overrides of [{ event: 'pull_request' }, { event: 'repository_dispatch' },
    { head_branch: 'feature' }, { head_sha: 'b'.repeat(40) }]) {
    assert.throws(() => validatePublicationRecord(record(), completedRun(overrides)), /completed main source/);
  }
});

test('artifact data cannot select another workflow, repository, run attempt or notification destination', () => {
  for (const overrides of [{ path: '.github/workflows/attacker.yml' },
    { repository: { full_name: 'other/repo' } }, { head_repository: { full_name: 'other/repo' } },
    { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'cancelled' }]) {
    assert.throws(() => validatePublicationRecord(record(), completedRun(overrides)), /successful same-repository/);
  }
  for (const overrides of [{ run_id: 101 }, { run_attempt: 1 }, { run_attempt: '2' }]) {
    assert.throws(() => validatePublicationRecord({ ...record(), ...overrides }, completedRun()), /completed run attempt/);
  }
  for (const altered of [
    { ...record(), executable: 'malicious.mjs' },
    { ...record(), publication: { ...packagePublication(stable), event_type: 'another-event' } },
    { ...record(), publication: { ...packagePublication(stable), client_payload: { ...packagePublication(stable).client_payload, upstream_repo: 'other/repo' } } },
  ]) {
    assert.throws(() => validatePublicationRecord(altered, completedRun()), /fixed package notification contract/);
  }
});

test('PR previews bind the successful run to the current same-repository PR head', () => {
  assert.deepEqual(validatePublicationRecord(record(preview), prRun(), currentPr()), { ...preview, packageVersion: undefined });
  const redirected = record(preview);
  redirected.publication.client_payload.preview_url = 'https://another.example/package.tgz';
  assert.throws(() => validatePublicationRecord(redirected, prRun(), currentPr()), /fixed package notification contract/);
  for (const overrides of [{ head_sha: 'b'.repeat(40) }, { pull_requests: [] }, { pull_requests: [{ number: 145 }] }]) {
    assert.throws(() => validatePublicationRecord(record(preview), prRun(overrides), currentPr()), /workflow run PR and head/);
  }
  for (const overrides of [{ state: 'closed' }, { number: 145 },
    { head: { sha: 'b'.repeat(40), repo: repository } },
    { head: { sha: sourceSha, repo: { full_name: 'fork/embody' } } },
    { base: { ref: 'release', repo: repository } },
    { base: { ref: 'main', repo: { full_name: 'other/repo' } } }]) {
    assert.throws(() => validatePublicationRecord(record(preview), prRun(), currentPr(overrides)), /current open same-repository PR head/);
  }
  assert.throws(() => validatePublicationRecord(record({ ...preview, upstreamPr: null }), prRun()), /workflow run PR and head/);
});

test('manual previews may be unlinked, but a linked preview must identify the current PR source', () => {
  for (const event of ['workflow_dispatch', 'repository_dispatch']) {
    const run = completedRun({ event, head_sha: 'b'.repeat(40) });
    const unlinked = validatePublicationRecord(record({ ...preview, upstreamPr: null }), run);
    assert.equal(unlinked.upstreamPr, null);
    validatePublicationRecord(record(preview), run, currentPr());
    assert.throws(() => validatePublicationRecord(record(preview), run, currentPr({ state: 'closed' })), /current open same-repository/);
  }
  assert.throws(() => validatePublicationRecord(record(preview), completedRun(), currentPr()), /unsupported workflow event/);
});
