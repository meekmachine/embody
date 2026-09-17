import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../service-worker/character-asset-service-worker.js', import.meta.url), 'utf8');
const sourceHeader = 'X-Embody-Asset-Source';
const cacheKey = 'https://embody.asset-cache.local/characters/test.glb';

function worker(fetch, { entries = new Map(), put } = {}) {
  const listeners = new Map();
  const cache = {
    async match(request) {
      return entries.get(typeof request === 'string' ? request : request.url)?.clone();
    },
    async put(request, response) {
      if (put) await put(response);
      entries.set(typeof request === 'string' ? request : request.url, response.clone());
    },
    async keys() {
      return [...entries.keys()].map((url) => new Request(url));
    },
  };
  vm.runInNewContext(source, {
    URL, Request, Response, Headers, fetch, console,
    caches: { async open() { return cache; } },
    self: { addEventListener(type, listener) { listeners.set(type, listener); } },
  });

  return function dispatch(url) {
    let response;
    const background = [];
    listeners.get('fetch')({
      request: new Request(url),
      respondWith(value) { response = Promise.resolve(value); },
      waitUntil(value) { background.push(value); },
    });
    return { response, background };
  };
}

test('identifies network and subsequent cache reads without storing stale provenance', async () => {
  let fetchCount = 0;
  const entries = new Map();
  const dispatch = worker(async () => {
    fetchCount++;
    return new Response('glb', {
      headers: { 'content-type': 'model/gltf-binary', 'content-length': '3' },
    });
  }, { entries });

  const first = dispatch('https://cdn.example/characters/test.glb?v=one');
  const downloaded = await first.response;
  assert.equal(downloaded.headers.get(sourceHeader), 'network');
  assert.equal(await downloaded.text(), 'glb');
  await Promise.all(first.background);
  assert.equal(entries.get(cacheKey).headers.get(sourceHeader), null);

  const cached = await dispatch('https://cdn.example/characters/test.glb?v=two').response;
  assert.equal(cached.headers.get(sourceHeader), 'cache');
  assert.equal(cached.headers.get('content-length'), '3');
  assert.equal(await cached.text(), 'glb');
  assert.equal(fetchCount, 1);
});

test('localhost identifies its actual network path even when a cached entry exists', async () => {
  const url = 'http://127.0.0.1:5173/characters/test.glb';
  const dispatch = worker(async () => new Response('fresh'), {
    entries: new Map([[url, new Response('old')]]),
  });
  const request = dispatch(url);
  const response = await request.response;
  assert.equal(response.headers.get(sourceHeader), 'network');
  assert.equal(await response.text(), 'fresh');
  await Promise.all(request.background);
});

test('localhost offline fallback identifies the cached response', async () => {
  const url = 'http://localhost:5173/characters/test.glb';
  const dispatch = worker(async () => { throw new TypeError('offline'); }, {
    entries: new Map([[url, new Response('offline-glb')]]),
  });
  const response = await dispatch(url).response;
  assert.equal(response.headers.get(sourceHeader), 'cache');
  assert.equal(await response.text(), 'offline-glb');
});

test('preserves status, payload, and existing exposed cross-origin headers', async () => {
  const dispatch = worker(async () => new Response('partial', {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'content-type': 'model/gltf-binary',
      'content-range': 'bytes 0-6/100',
      'Access-Control-Expose-Headers': 'ETag, Content-Range',
    },
  }));
  const response = await dispatch('https://cdn.example/characters/test.glb').response;
  assert.equal(response.status, 206);
  assert.equal(response.statusText, 'Partial Content');
  assert.equal(response.headers.get('content-range'), 'bytes 0-6/100');
  assert.equal(response.headers.get('Access-Control-Expose-Headers'), `ETag, Content-Range, ${sourceHeader}`);
  assert.equal(await response.text(), 'partial');
});

test('passes opaque and error responses through without reconstruction', async () => {
  for (const original of [Response.error(), { status: 0, type: 'opaque' }, { status: 0, type: 'opaqueredirect' }]) {
    const dispatch = worker(async () => original);
    assert.equal(await dispatch('https://cdn.example/characters/test.glb').response, original);
  }
});

test('returns headers and streamed bytes before the body and cache write finish', { timeout: 2000 }, async () => {
  let controller;
  let finishPut;
  const putGate = new Promise((resolve) => { finishPut = resolve; });
  const stream = new ReadableStream({
    start(value) { controller = value; },
  });
  const dispatch = worker(async () => new Response(stream), { put: () => putGate });
  const request = dispatch('https://cdn.example/characters/test.glb');
  const response = await request.response;
  assert.equal(response.headers.get(sourceHeader), 'network');
  controller.enqueue(new Uint8Array([1, 2, 3]));
  const reader = response.body.getReader();
  assert.deepEqual(await reader.read(), { value: new Uint8Array([1, 2, 3]), done: false });
  controller.close();
  assert.equal((await reader.read()).done, true);
  finishPut();
  await Promise.all(request.background);
});
