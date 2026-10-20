import assert from 'node:assert/strict';
import test from 'node:test';
import { DeepSeek } from '../dist/deepseek.js';

function interruptedResponse(status) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":'));
      controller.error(new Error('body interrupted'));
    },
  }), { status, headers: { 'Retry-After': '0' } });
}

test('retries transient HTTP failures and honors Retry-After', async () => {
  const statuses = [429, 503, 200];
  let requests = 0;
  const api = new DeepSeek({
    apiKey: 'test-key',
    fetch: async (url, request) => {
      assert.equal(url.href, 'https://api.deepseek.com/v1/tools/search');
      assert.equal(request.headers.Authorization, 'Bearer test-key');
      const status = statuses[requests++];
      return Response.json(status === 200 ? { results: [] } : { error: { message: 'Try later' } }, {
        status,
        headers: { 'Retry-After': '0' },
      });
    },
  });
  assert.deepEqual(await api.search({ query: 'test' }, new AbortController().signal), { results: [] });
  assert.equal(requests, 3);
});

test('retries a transient HTTP failure when its body is interrupted', async () => {
  let requests = 0;
  const api = new DeepSeek({ apiKey: 'test-key', fetch: async () => {
    requests++;
    return requests === 1 ? interruptedResponse(503) : Response.json({ results: [] });
  } });
  assert.deepEqual(await api.search({ query: 'test' }, new AbortController().signal), { results: [] });
  assert.equal(requests, 2);
});

test('does not retry permanent errors and redacts the key', async () => {
  let requests = 0;
  const api = new DeepSeek({ apiKey: 'secret-key', fetch: async () => {
    requests++;
    return Response.json({ error: { message: 'Invalid secret-key' } }, { status: 401 });
  } });
  await assert.rejects(api.fetch('https://example.com', new AbortController().signal), /HTTP 401.*\[redacted\]/);
  assert.equal(requests, 1);
});

for (const [status, attempts] of [[400, 1], [503, 3]]) {
  test(`includes HTTP ${status} when an error body cannot be read`, async () => {
    let requests = 0;
    const api = new DeepSeek({ apiKey: 'test-key', fetch: async () => {
      requests++;
      return interruptedResponse(status);
    } });
    await assert.rejects(api.search({ query: 'test' }, new AbortController().signal), new RegExp(`HTTP ${status}.*Could not read the error response body`));
    assert.equal(requests, attempts);
  });
}

test('rejects timeout values outside the Node timer range', () => {
  assert.throws(() => new DeepSeek({ apiKey: 'test', timeoutMs: 2_147_483_648 }), /REQUEST_TIMEOUT_MS.*2147483647/);
  assert.throws(() => new DeepSeek({ apiKey: 'test', timeoutMs: 1.5 }), /REQUEST_TIMEOUT_MS.*integer/);
});

test('the request deadline covers Retry-After waits', async () => {
  let requests = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const api = new DeepSeek({ apiKey: 'test', timeoutMs: 20, fetch: async () => {
      requests++;
      return new Response('', { status: 429, headers: { 'Retry-After': '3600' } });
    } });
    await assert.rejects(api.search({ query: 'test' }, new AbortController().signal), /timed out/);
    assert.equal(requests, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('cancelling aborts upstream I/O without retrying', async () => {
  let requests = 0;
  const controller = new AbortController();
  const api = new DeepSeek({ apiKey: 'test', fetch: async (_url, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cancellation was not forwarded')), 1000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  } });
  const pending = api.fetch('https://example.com', controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(requests, 1);
});
