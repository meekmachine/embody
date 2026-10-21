import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const isSha = value => typeof value === 'string' && value.length === 40 && /^[0-9a-f]{40}$/.test(value);

export function packageSource({ eventName, ref, sha, event }) {
  let sourceRef;
  switch (eventName) {
    case 'pull_request':
      sourceRef = event.pull_request?.head?.sha;
      if (!isSha(sourceRef)) throw new Error('PR previews require the full PR head SHA.');
      break;
    case 'repository_dispatch':
      if (event.action !== 'publish-pkg-pr-new') throw new Error('Unsupported package publication request.');
      sourceRef = event.client_payload?.sha;
      if (!isSha(sourceRef)) throw new Error('Preview dispatches require a full client_payload.sha.');
      break;
    case 'workflow_dispatch':
      sourceRef = event.inputs?.ref || sha;
      break;
    case 'push':
      sourceRef = sha;
      break;
    default:
      throw new Error(`Unsupported package event: ${eventName}`);
  }
  if (typeof sourceRef !== 'string' || !sourceRef || /[\r\n\0]/.test(sourceRef)) {
    throw new Error('A single source ref or SHA is required.');
  }
  const stableRelease = ref === 'refs/heads/main' && (
    eventName === 'push' || (eventName === 'workflow_dispatch' && !event.inputs?.ref)
  );
  if (stableRelease && (!isSha(sha) || sourceRef !== sha)) {
    throw new Error('Stable publication must use the exact triggering main commit.');
  }
  return { sourceRef, stableRelease };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const source = packageSource({
      eventName: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    });
    const output = `source_ref=${source.sourceRef}\nstable_release=${source.stableRelease}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
