import { isDeepStrictEqual } from 'node:util';

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function packagePublication({ channel, sourceSha, packageVersion, upstreamPr }) {
  if (!SOURCE_SHA.test(sourceSha)) throw new Error('Publication requires the full checked-out source SHA.');
  const payload = {
    upstream_repo: 'meekmachine/embody',
    package_name: '@lovelace_lol/embody',
    source_sha: sourceSha,
    channel,
  };
  if (channel === 'stable') {
    if (!STABLE_VERSION.test(packageVersion)) throw new Error('Stable publication requires an exact npm version.');
    payload.package_version = packageVersion;
  } else if (channel === 'preview') {
    const number = upstreamPr === undefined || upstreamPr === null || upstreamPr === '' ? null : Number(upstreamPr);
    if (number !== null && (!/^[1-9]\d*$/.test(String(upstreamPr)) || !Number.isSafeInteger(number))) {
      throw new Error('The upstream PR must be a positive integer or absent.');
    }
    // Called only after pkg.pr.new succeeds for this exact checkout. Manual
    // previews without a PR remain identifiable but do not request a PR update.
    payload.preview_url = `https://pkg.pr.new/meekmachine/embody/@lovelace_lol/embody@${sourceSha}`;
    payload.upstream_pr = number;
  } else {
    throw new Error('Publication channel must be stable or preview.');
  }
  return { event_type: 'upstream-package-published', client_payload: payload };
}

// Artifact contents are data from a potentially PR-controlled producer. They
// cannot select a repository, endpoint, workflow, credential or executable.
export function validatePublicationRecord(record, run, pullRequest) {
  if (run?.repository?.full_name !== 'meekmachine/embody'
      || run?.head_repository?.full_name !== 'meekmachine/embody'
      || run.path !== '.github/workflows/pr-checks.yml'
      || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Publication must come from a successful same-repository package workflow.');
  }
  if (!Number.isSafeInteger(record?.run_id) || !Number.isSafeInteger(record?.run_attempt)
      || record.run_id !== run.id || record.run_attempt !== run.run_attempt) {
    throw new Error('Publication artifact does not identify the completed run attempt.');
  }
  const payload = record?.publication?.client_payload;
  if (!payload) throw new Error('Publication artifact is missing its package payload.');
  const input = {
    channel: payload.channel, sourceSha: payload.source_sha,
    packageVersion: payload.package_version, upstreamPr: payload.upstream_pr,
  };
  const publication = packagePublication(input);
  if (!isDeepStrictEqual(record, { run_id: run.id, run_attempt: run.run_attempt, publication })) {
    throw new Error('Publication artifact differs from the fixed package notification contract.');
  }
  if (input.channel === 'stable') {
    if (!['push', 'workflow_dispatch'].includes(run.event) || run.head_branch !== 'main'
        || input.sourceSha !== run.head_sha) {
      throw new Error('Stable publication must identify the completed main source commit.');
    }
  } else {
    if (!['pull_request', 'workflow_dispatch', 'repository_dispatch'].includes(run.event)) {
      throw new Error('Preview publication has an unsupported workflow event.');
    }
    if (run.event === 'pull_request'
        && (input.sourceSha !== run.head_sha || !input.upstreamPr
          || !run.pull_requests?.some((pr) => pr.number === input.upstreamPr))) {
      throw new Error('Preview publication does not identify the workflow run PR and head.');
    }
    if (input.upstreamPr !== null) {
      if (pullRequest?.number !== input.upstreamPr || pullRequest.state !== 'open'
          || pullRequest.head?.repo?.full_name !== 'meekmachine/embody'
          || pullRequest.base?.repo?.full_name !== 'meekmachine/embody'
          || pullRequest.base?.ref !== 'main' || pullRequest.head?.sha !== input.sourceSha) {
        throw new Error('Preview publication must match the current open same-repository PR head targeting main.');
      }
    }
  }
  return input;
}

export async function notifyPackagePublication(input, token = process.env.CROSS_REPO_CI_TOKEN, send = fetch) {
  const event = packagePublication(input);
  if (typeof token !== 'string' || !token || /\s/.test(token)) {
    throw new Error('CROSS_REPO_CI_TOKEN is required to notify LoomLarge of the published package.');
  }
  const response = await send('https://api.github.com/repos/meekmachine/LoomLarge/dispatches', {
    method: 'POST',
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.redirected || response.status !== 204) {
    throw new Error(`LoomLarge package notification failed: HTTP ${response.status}`);
  }
}
