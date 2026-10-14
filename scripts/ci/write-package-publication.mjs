#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { packagePublication } from './package-publication.mjs';

const runId = Number(process.env.GITHUB_RUN_ID);
const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
if (!Number.isSafeInteger(runId) || runId <= 0 || !Number.isSafeInteger(runAttempt) || runAttempt <= 0) {
  throw new Error('Publication record requires the producing workflow run and attempt.');
}
const publication = packagePublication({
  channel: process.env.PUBLICATION_CHANNEL,
  sourceSha: process.env.SOURCE_SHA,
  packageVersion: process.env.PACKAGE_VERSION,
  upstreamPr: process.env.UPSTREAM_PR,
});
writeFileSync(process.env.PUBLICATION_FILE, JSON.stringify({ run_id: runId, run_attempt: runAttempt, publication }));
