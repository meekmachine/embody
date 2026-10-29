#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { notifyPackagePublication, validatePublicationRecord } from './package-publication.mjs';

if (process.env.GITHUB_EVENT_NAME !== 'workflow_run' || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Package notifications run only in the trusted main workflow_run receiver.');
}
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const runId = event.workflow_run?.id;
if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Missing completed workflow run identity.');
const token = process.env.GH_TOKEN;
if (!token || /\s/.test(token)) throw new Error('GH_TOKEN is required to validate the publication run.');
async function github(path) {
  const response = await fetch(`https://api.github.com/repos/meekmachine/embody/${path}`, {
    redirect: 'error',
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.redirected || !response.ok) throw new Error(`Publication source lookup failed: HTTP ${response.status}`);
  return response.json();
}
// Re-read this run once so an obsolete success event cannot authorize a newer,
// failed/in-progress attempt. Artifact files never become executable code.
const run = await github(`actions/runs/${runId}`);
if (run.run_attempt !== event.workflow_run.run_attempt) throw new Error('Completed publication event is from an obsolete run attempt.');
const artifact = process.env.PUBLICATION_FILE;
const artifactStat = artifact ? lstatSync(artifact) : undefined;
if (!artifactStat?.isFile() || artifactStat.size > 8192) throw new Error('Publication artifact must be a bounded regular JSON file.');
const record = JSON.parse(readFileSync(artifact, 'utf8'));
const prNumber = record?.publication?.client_payload?.upstream_pr;
const pullRequest = Number.isSafeInteger(prNumber) && prNumber > 0 ? await github(`pulls/${prNumber}`) : undefined;
const input = validatePublicationRecord(record, run, pullRequest);
if (input.channel === 'preview') {
  // Prove the canonical full-SHA URL exists after publication. No retries or
  // mutable aliases: a missing artifact fails this notification visibly.
  const url = `https://pkg.pr.new/meekmachine/embody/@lovelace_lol/embody@${input.sourceSha}`;
  const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Published preview is unavailable: HTTP ${response.status}`);
}
await notifyPackagePublication(input);
console.log('Notified LoomLarge of the published Embody package.');
