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
