import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { shouldPublishRelease } from './npm-release.mjs';

export function assertTrustedPublishingToolchain(nodeVersion, npmVersion) {
  const atLeast = (actual, minimum) => {
    if (!/^\d+\.\d+\.\d+$/.test(actual)) return false;
    const parts = actual.split('.').map(Number);
    for (let index = 0; index < minimum.length; index += 1) {
      if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
    }
    return true;
  };
  if (!atLeast(nodeVersion, [22, 14, 0]) || !atLeast(npmVersion, [11, 5, 1])) {
    throw new Error('npm trusted publishing requires Node >=22.14.0 and npm >=11.5.1; use the configured Node 24 publish job.');
  }
}

export function npmFailure(error, publisher) {
  // Inspect npm diagnostics only for a known code. Never print captured output,
  // request headers, bearer tokens, or npm's credential-bearing environment.
  const diagnostic = `${error.stderr ?? ''} ${error.stdout ?? ''} ${error.message ?? ''}`;
  const code = diagnostic.match(/\b(EOTP|ENEEDAUTH|E401|E403|E404|EPUBLISHCONFLICT|E409|E429|E500|E502|E503|ETIMEDOUT|ECONNRESET|ENOTFOUND|ENETUNREACH|EINTEGRITY)\b/)?.[1];
  const prefix = `npm command failed${code ? ` (${code})` : ''}.`;
  if (!['EOTP', 'ENEEDAUTH', 'E401', 'E403', 'E404'].includes(code)) {
    return new Error(`${prefix} Check registry availability, network access and release identity before retrying the main release. Captured npm output is omitted to protect credentials. No stable publication receipt was issued.`);
  }
  const identity = `${publisher.repository}, workflow ${publisher.workflow}, environment npm`;
  return new Error(`${prefix} Check the npm trusted publisher for ${identity}, enable "Allow npm publish", and keep id-token: write on the main-only publish job. Do not supply an OTP or weaken account 2FA. No stable publication receipt was issued.`);
}

export function runNpm(args, publisher) {
  try {
    return execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw npmFailure(error, publisher);
  }
}

export async function readNpmPublicStatus(packageName, fetchMetadata = fetch) {
  // This is the same endpoint used by npm access get status. Read it directly
  // so npm config cannot attach a token to an anonymous visibility check.
  const response = await fetchMetadata(`https://registry.npmjs.org/-/package/${encodeURIComponent(packageName)}/visibility`, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.redirected) throw new Error('npm visibility redirects are not permitted.');
  if (!response.ok) throw new Error(`Cannot read npm package visibility: HTTP ${response.status}`);
  const visibility = await response.json();
  if (typeof visibility?.public !== 'boolean') throw new Error('npm visibility response must explicitly identify public or private status.');
  return { [packageName]: visibility.public ? 'public' : 'private' };
}

export async function readNpmVersion(packageName, version, fetchMetadata = fetch) {
  const response = await fetchMetadata(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`, {
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.redirected) throw new Error('npm version metadata redirects are not permitted.');
  // Only an exact-version 404 means absence. Auth/network/registry failures
  // must never authorize uploading a version whose identity is unknown.
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Cannot confirm npm version ${packageName}@${version}: HTTP ${response.status}`);
  const record = await response.json();
  if (record?.name !== packageName || record.version !== version) {
    throw new Error('npm returned a different exact package/version than requested.');
  }
  return record;
}

function assertReleaseDependencies(record, pkg) {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const sorted = (value) => Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right));
    if (JSON.stringify(sorted(record[field])) !== JSON.stringify(sorted(pkg[field]))) {
      throw new Error(`npm version ${pkg.version} has different ${field} than the verified package; downstream notification is blocked.`);
    }
  }
}

export async function publishAndConfirm({ pkg, archive, integrity, sourceSha, publisher, readMetadata, readVersion, publish }) {
  const expectedName = publisher.packageName;
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (repository !== `git+https://github.com/${publisher.repository}.git`) {
    throw new Error('Packed repository.url must identify the GitHub repository registered as the npm trusted publisher.');
  }
  const index = await readMetadata(expectedName);
  // The package-wide index can lag a successful upload. Resolve this exact
  // version before publishing, so retries do not attempt a duplicate upload.
  const existing = await readVersion(expectedName, pkg.version);
  if (index.versions[pkg.version] && !existing) {
    throw new Error('npm package index and exact-version lookup disagree; refusing to upload an uncertain release.');
  }
  const before = existing ? { ...index, versions: { ...index.versions, [pkg.version]: existing } } : index;
  const needsPublish = shouldPublishRelease(before, pkg, expectedName, sourceSha);
  if (existing) assertReleaseDependencies(existing, pkg);
  if (needsPublish) {
    // An explicit local path prevents npm interpreting owner/file as Git shorthand.
    // This is the one publication attempt; no lifecycle scripts rebuild the tarball.
    await publish(['publish', resolve(archive), '--access', 'public', '--provenance=false', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
  }
  // Confirm against the exact-version endpoint, avoiding a stale package index.
  // One anonymous confirmation lookup, with no polling or silent upload retry.
  const record = needsPublish ? await readVersion(expectedName, pkg.version) : existing;
  const confirmed = record ? { ...before, versions: { ...before.versions, [pkg.version]: record } } : before;
  if (shouldPublishRelease(confirmed, pkg, expectedName, sourceSha)) {
    throw new Error('npm returned success but the expected stable source/version is absent from the registry. Retry the main release after investigating; downstream notification is blocked.');
  }
  assertReleaseDependencies(record, pkg);
  const registryIntegrity = record.dist?.integrity;
  if (typeof registryIntegrity !== 'string' || !registryIntegrity.startsWith('sha512-')) {
    throw new Error('The registry release has no SHA-512 archive integrity; downstream notification is blocked.');
  }
  if (needsPublish && registryIntegrity !== integrity) {
    throw new Error('The registry tarball integrity does not match the verified archive; downstream notification is blocked.');
  }
  // Reruns retain immutable release identity, not an assumption that compiling
  // the same source twice reproduces every byte of the original archive.
  return { package: expectedName, version: pkg.version, sourceSha, integrity: registryIntegrity,
    status: needsPublish ? 'published' : 'already-published',
    archiveVerification: needsPublish ? 'uploaded archive matches verified tarball' : 'existing release identity confirmed; no upload' };
}

export function formatPublicationReceipt(receipt) {
  return `### Stable npm publication confirmed\n\n- Package: \`${receipt.package}@${receipt.version}\`\n- Source: \`${receipt.sourceSha}\`\n- Archive integrity: \`${receipt.integrity}\`\n- Result: ${receipt.status}\n- Archive confirmation: ${receipt.archiveVerification}\n\nThe registry confirms this source/version and records its archive integrity. Downstream adoption is a separate coordinator step; this receipt does not establish production deployment.\n`;
}
