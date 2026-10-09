const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;

function parseVersion(version) {
  if (typeof version !== 'string' || !STABLE_VERSION.test(version)) {
    throw new Error(`Expected an exact stable npm version, received ${version}`);
  }
  return version.split('.').map(Number);
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function stableVersions(metadata) {
  if (!metadata || typeof metadata.versions !== 'object' || !metadata.versions
      || Array.isArray(metadata.versions)) {
    throw new Error('npm response is missing its published version records.');
  }
  const versions = Object.keys(metadata.versions).filter((version) => STABLE_VERSION.test(version));
  for (const version of versions) {
    const record = metadata.versions[version];
    if (!record || record.version !== version || record.name !== metadata.name) {
      throw new Error(`npm returned invalid metadata for ${metadata.name}@${version}.`);
    }
  }
  return versions.sort(compareVersions);
}

export async function readNpmMetadata(packageName, fetchMetadata = fetch) {
  const response = await fetchMetadata(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  // Both packages already exist. A failed lookup must never be interpreted as
  // permission to restart numbering at 0.0.1 or overwrite a release identity.
  if (!response.ok) throw new Error(`Cannot read npm metadata for ${packageName}: HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata?.name !== packageName) throw new Error(`npm returned a different package than ${packageName}.`);
  if (stableVersions(metadata).length === 0) throw new Error(`npm has no stable versions for ${packageName}.`);
  return metadata;
}

export function selectRelease(metadata, manifestVersion, sourceSha, headTags = []) {
  if (!SOURCE_SHA.test(sourceSha)) throw new Error('A full source commit SHA is required.');
  const versions = stableVersions(metadata);
  parseVersion(manifestVersion);
  const matching = versions.filter((version) => metadata.versions[version].gitHead === sourceSha);
  if (matching.length > 1) throw new Error(`Multiple npm releases already identify source ${sourceSha}.`);
  const taggedVersions = headTags.filter((tag) => tag.startsWith('v') && STABLE_VERSION.test(tag.slice(1)))
    .map((tag) => tag.slice(1));
  if (taggedVersions.length > 1) throw new Error('The source commit has multiple stable release tags.');

  if (matching.length === 1) {
    if (taggedVersions.length && taggedVersions[0] !== matching[0]) {
      throw new Error('The source release tag disagrees with its published npm version.');
    }
    return { version: matching[0], exists: true };
  }
  if (taggedVersions.length === 1) {
    const version = taggedVersions[0];
    if (metadata.versions[version]) throw new Error(`npm version ${version} belongs to another source commit.`);
    if (versions.some((published) => compareVersions(published, version) >= 0)) {
      throw new Error(`Unpublished tag v${version} is behind an existing npm release.`);
    }
    return { version, exists: false };
  }

  const highest = [...versions, manifestVersion].sort(compareVersions).at(-1);
  const [major, minor, patch] = parseVersion(highest);
  return { version: `${major}.${minor}.${patch + 1}`, exists: false };
}

export function assertNewReleaseDescendsFromPublished(metadata, sourceSha, isAncestor) {
  const latestVersion = stableVersions(metadata).at(-1);
  const latestSha = metadata.versions[latestVersion]?.gitHead;
  if (!SOURCE_SHA.test(latestSha) || !SOURCE_SHA.test(sourceSha)) {
    throw new Error('Cannot verify the source order of the latest npm release: a full gitHead is required.');
  }
  if (!isAncestor(latestSha, sourceSha)) {
    throw new Error(`Source ${sourceSha} does not contain npm ${latestVersion} source ${latestSha}; refusing an older release.`);
  }
}

export function shouldPublishRelease(metadata, pkg, expectedName, sourceSha) {
  if (!SOURCE_SHA.test(sourceSha) || pkg.gitHead !== sourceSha || pkg.name !== expectedName) {
    throw new Error('Packed npm package does not match the verified package name and source commit.');
  }
  parseVersion(pkg.version);
  const versions = stableVersions(metadata);
  if (metadata.name !== expectedName) throw new Error('npm returned metadata for another package.');
  const existing = metadata.versions[pkg.version];
  if (existing) {
    if (existing.gitHead !== sourceSha) throw new Error(`npm version ${pkg.version} belongs to another source commit.`);
    return false;
  }
  if (versions.some((version) => metadata.versions[version].gitHead === sourceSha)) {
    throw new Error('This source commit has already been published under another npm version.');
  }
  if (versions.some((version) => compareVersions(version, pkg.version) >= 0)) {
    throw new Error(`Refusing to publish ${pkg.version} behind an existing npm release.`);
  }
  return true;
}
