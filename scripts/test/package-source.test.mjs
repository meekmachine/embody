import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { packageSource } from '../ci/package-source.mjs';

const mainSha = 'a'.repeat(40);
const sourceSha = 'b'.repeat(40);
const request = (eventName, ref = 'refs/heads/main', event = {}, sha = mainSha) => (
  packageSource({ eventName, ref, sha, event })
);

for (const draft of [true, false]) {
  for (const action of ['opened', 'edited', 'synchronize', 'reopened', 'ready_for_review']) {
    test(`${draft ? 'draft' : 'ready'} PR ${action} selects its exact preview source without npm readiness`, () => {
      assert.deepEqual(request('pull_request', 'refs/pull/42/merge', {
        action,
        pull_request: { draft, head: { sha: sourceSha }, body: 'Depends-on: upstream#123' },
      }), { sourceRef: sourceSha, stableRelease: false });
    });
  }
}

test('PR input cannot request a stable release even if its workflow ref is main', () => {
  assert.equal(request('pull_request', undefined, { pull_request: { head: { sha: sourceSha } } }).stableRelease, false);
});

test('main push selects the exact triggering commit for stable readiness', () => {
  assert.deepEqual(request('push'), { sourceRef: mainSha, stableRelease: true });
});

test('manual main release has an empty ref and validates the exact triggering commit', () => {
  for (const inputs of [{}, { ref: '' }]) {
    assert.deepEqual(request('workflow_dispatch', undefined, { inputs }), { sourceRef: mainSha, stableRelease: true });
  }
});

for (const ref of [sourceSha, 'main', 'feature/unfinished-stack']) {
  test(`explicit manual ref ${ref} stays a preview, even when dispatched from main`, () => {
    assert.deepEqual(request('workflow_dispatch', undefined, { inputs: { ref } }), { sourceRef: ref, stableRelease: false });
  });
}

test('manual run on another branch cannot publish stable npm', () => {
  assert.deepEqual(request('workflow_dispatch', 'refs/heads/feature', { inputs: { ref: '' } }),
    { sourceRef: mainSha, stableRelease: false });
});

test('repository dispatch uses its immutable requested source, never the Actions main SHA', () => {
  assert.deepEqual(request('repository_dispatch', undefined, {
    action: 'publish-pkg-pr-new', client_payload: { sha: sourceSha },
  }), { sourceRef: sourceSha, stableRelease: false });
});

for (const sha of [undefined, '', 'main', 'abc123', sourceSha + '\n', 'x'.repeat(40)]) {
  test(`dispatch rejects a missing or mutable preview source ${JSON.stringify(sha)}`, () => {
    assert.throws(() => request('repository_dispatch', undefined, {
      action: 'publish-pkg-pr-new', client_payload: { sha },
    }), /full client_payload.sha/);
  });
}

test('unsupported events and invalid source/output values fail closed', () => {
  assert.throws(() => request('workflow_run'), /Unsupported package event/);
  assert.throws(() => request('repository_dispatch', undefined, { action: 'other' }), /Unsupported package publication/);
  assert.throws(() => request('pull_request', undefined, { pull_request: { head: { sha: 'main' } } }), /full PR head SHA/);
  assert.throws(() => request('push', undefined, {}, 'main'), /exact triggering main commit/);
  for (const ref of ['main\nstable_release=true', 'main\r', 'main\0', {}]) {
    assert.throws(() => request('workflow_dispatch', undefined, { inputs: { ref } }), /single source ref/);
  }
});

const workflow = readFileSync(new URL('../../.github/workflows/pr-checks.yml', import.meta.url), 'utf8');
const sourceJob = workflow.split('  package-source:')[1].split('  verify:')[0];

test('event policy executes before checkout of the requested source and without release credentials', () => {
  assert.match(sourceJob, /ref: \$\{\{ github.workflow_sha \}\}/);
  assert.match(sourceJob, /run: node scripts\/ci\/package-source.mjs/);
  assert.doesNotMatch(sourceJob, /secrets\.|environment:|determine-release-version|prepare-npm-embody/);
  assert.match(workflow, /ref: \$\{\{ needs.package-source.outputs.source_ref \}\}/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, edited, ready_for_review\]/);
});

test('preview verification retains its required check name and keeps npm preparation release-only', () => {
  const verifyJob = workflow.split('  verify:')[1].split('  publish-npm:')[0];
  assert.match(verifyJob, /name: Verify built package/);
  assert.doesNotMatch(verifyJob, /pull_request.draft/);
  assert.match(verifyJob, /if: needs.package-source.outputs.stable_release == 'true'[\s\S]*id: release[\s\S]*run: node scripts\/ci\/determine-release-version.mjs/);
  assert.match(verifyJob, /if: needs.package-source.outputs.stable_release != 'true'[\s\S]*npx --no-install pkg-pr-new/);
});

test('stable publishing consumes the verified tarball behind the existing main and npm gates', () => {
  const publishJob = workflow.split('  publish-npm:')[1].split('  record-publication:')[0];
  assert.match(publishJob, /needs: verify/);
  assert.match(publishJob, /github.ref == 'refs\/heads\/main'/);
  assert.match(publishJob, /needs.verify.outputs.stable_release == 'true'/);
  assert.match(publishJob, /environment: npm/);
  assert.match(publishJob, /ref: \$\{\{ needs.verify.outputs.release_commit \}\}/);
  assert.match(publishJob, /node scripts\/ci\/publish-npm-release.mjs release-package\/\*.tgz/);
  assert.doesNotMatch(publishJob, /run: npm run build/);
});

