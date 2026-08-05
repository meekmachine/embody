// Character asset cache service worker.
//
// Embody owns character loading, so it also ships this worker. Hosts copy the
// file to their web root (it must be served same-origin at or above the page
// scope) and register it, e.g.:
//
//   navigator.serviceWorker.register(`${BASE_URL}service-worker.js`);
//
// Caching policy: character assets (models, textures, thumbnails, preview
// clips) are cache-first on deployed origins and network-first on localhost,
// keyed by a stable origin-independent object path so preview deploys share
// one cache.
const SW_VERSION = 'v1';
const CHARACTER_CACHE = `embody-character-assets-${SW_VERSION}`;
const LEGACY_CACHE_PREFIXES = ['embody-character-assets-', 'loomlarge-character-assets-'];
const SHARED_CACHE_DOMAINS = ['web.app'];
const STABLE_ASSET_CACHE_ORIGIN = 'https://embody.asset-cache.local';
const ASSET_PATH_PREFIXES = [
  'characters',
  'thumbnails',
  'preview-clips',
  'previews',
  'textures',
  'models',
  'animations',
];

function isCharacterAssetRequest(url) {
  const pathname = url.pathname || '';
  return (
    ASSET_PATH_PREFIXES.some((prefix) => pathname.includes(`/${prefix}/`)) ||
    /\.(glb|gltf|bin|fbx|ktx2?|basis|png|jpe?g|webp|gif|avif|webm)(?:$|\?)/i.test(pathname)
  );
}

function isLocalhost(url) {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '0.0.0.0'
  );
}

function isCacheableResponse(response) {
  if (!response) {
    return false;
  }

  if (response.status !== 200) {
    return false;
  }

  if (response.type === 'opaque') {
    return false;
  }

  if (!response.ok) {
    return false;
  }

  const contentType = response.headers.get('content-type') || '';
  return !contentType.toLowerCase().includes('text/html');
}

// `response` must be a dedicated clone: cache.put consumes its body.
async function putInCache(cacheName, request, response) {
  if (!isCacheableResponse(response)) {
    return;
  }

  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
  } catch (error) {
    console.warn('[ServiceWorker] Failed to cache character asset:', error);
  }
}

// Avoid rewriting multi-hundred-megabyte cache entries when the network
// response is byte-identical to what we already stored (localhost reloads
// re-fetch every time, so this runs on every page load).
async function hasSameCachedEntry(cacheKey, response) {
  try {
    const cache = await caches.open(CHARACTER_CACHE);
    const cached = await cache.match(cacheKey);
    if (!cached) {
      return false;
    }

    const etag = response.headers.get('etag');
    if (etag) {
      return cached.headers.get('etag') === etag;
    }

    const contentLength = response.headers.get('content-length');
    return Boolean(contentLength) && cached.headers.get('content-length') === contentLength;
  } catch {
    return false;
  }
}

function normalizeCacheKey(url) {
  const cacheUrl = new URL(url.toString());
  cacheUrl.search = '';
  cacheUrl.hash = '';
  const sharedDomain = SHARED_CACHE_DOMAINS.find(
    (domain) => cacheUrl.hostname === domain || cacheUrl.hostname.endsWith(`.${domain}`),
  );

  if (sharedDomain) {
    cacheUrl.hostname = sharedDomain;
    cacheUrl.port = '';
  }

  return cacheUrl.toString();
}

function normalizeAssetObjectPath(url) {
  let decodedPathname = url.pathname || '';
  try {
    decodedPathname = decodeURIComponent(decodedPathname);
  } catch {
    // Keep the raw path if the URL contains a malformed escape sequence.
  }

  const pathname = decodedPathname.replace(/^\/+/, '');
  const pathParts = pathname.split('/').filter(Boolean);
  const supportedPrefixIndex = pathParts.findIndex((part) =>
    ASSET_PATH_PREFIXES.includes(part),
  );

  if (supportedPrefixIndex >= 0) {
    return pathParts.slice(supportedPrefixIndex).join('/');
  }

  if (pathParts[0] === 'assets' && pathParts.length > 1) {
    return pathParts.slice(1).join('/');
  }

  return pathname || null;
}

function stableAssetCacheKey(url) {
  const objectPath = normalizeAssetObjectPath(url);
  if (!objectPath) {
    return normalizeCacheKey(url);
  }

  return `${STABLE_ASSET_CACHE_ORIGIN}/${objectPath}`;
}

async function matchCachedAsset(cache, url) {
  const cacheKey = stableAssetCacheKey(url);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const objectPath = normalizeAssetObjectPath(url);
  if (!objectPath) {
    return null;
  }

  const cachedRequests = await cache.keys();
  for (const request of cachedRequests) {
    try {
      const cachedUrl = new URL(request.url);
      if (normalizeAssetObjectPath(cachedUrl) !== objectPath) {
        continue;
      }

      const legacyCached = await cache.match(request);
      if (legacyCached) {
        await cache.put(cacheKey, legacyCached.clone());
        return legacyCached;
      }
    } catch {
      // Ignore malformed legacy cache entries.
    }
  }

  return null;
}

// Cache in the background so the page starts consuming the response
// immediately instead of waiting for the full body to be written to disk.
function cacheInBackground(event, cacheKey, response, { skipIfUnchanged = false } = {}) {
  if (!isCacheableResponse(response)) {
    return;
  }

  const copy = response.clone();
  event.waitUntil(
    (async () => {
      if (skipIfUnchanged && (await hasSameCachedEntry(cacheKey, copy))) {
        return;
      }
      await putInCache(CHARACTER_CACHE, cacheKey, copy);
    })(),
  );
}

async function cacheFirstAsset(event, url) {
  const cache = await caches.open(CHARACTER_CACHE);
  const cached = await matchCachedAsset(cache, url);
  if (cached) {
    return cached;
  }

  const response = await fetch(event.request);
  cacheInBackground(event, stableAssetCacheKey(url), response);
  return response;
}

async function networkFirst(event, url) {
  const cacheKey = normalizeCacheKey(url);

  try {
    const response = await fetch(event.request);
    cacheInBackground(event, cacheKey, response, { skipIfUnchanged: true });
    return response;
  } catch (error) {
    const cache = await caches.open(CHARACTER_CACHE);
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              LEGACY_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
              key !== CHARACTER_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);
  if (!isCharacterAssetRequest(url)) {
    return;
  }

  if (isLocalhost(url)) {
    event.respondWith(networkFirst(event, url));
    return;
  }

  event.respondWith(cacheFirstAsset(event, url));
});
