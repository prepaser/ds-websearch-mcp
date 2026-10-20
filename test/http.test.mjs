import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ContentCache } from '../dist/cache.js';
import { createHttpHandler } from '../dist/http.js';
import { createServer } from '../dist/server.js';

const endpoint = 'http://127.0.0.1/mcp';
const initialize = {
  jsonrpc: '2.0', id: 0, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  },
};
const call = (id, query) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search', arguments: { query } } });
const list = { jsonrpc: '2.0', id: 9, method: 'tools/list' };

function request(handler, message, session, options = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (session) headers['Mcp-Session-Id'] = session;
  return handler.fetch(new Request(endpoint, {
    method: 'POST', headers, body: JSON.stringify(message), ...options,
  }));
}

async function connect(handler) {
  const response = await request(handler, initialize);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).result);
  const session = response.headers.get('mcp-session-id');
  assert.ok(session);
  const ready = await request(handler, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  assert.equal(ready.status, 202);
  return session;
}

function setup(t, options, customize) {
  const calls = new Map();
  const api = { search: async ({ query }, signal) => {
    const result = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    calls.set(query, { ...result, signal, aborted: aborted.promise });
    signal.addEventListener('abort', () => {
      aborted.resolve();
      result.reject(new Error('cancelled'));
    }, { once: true });
    return result.promise;
  } };
  const cache = new ContentCache();
  const handler = createHttpHandler(() => {
    const server = createServer(api, cache);
    customize?.(server);
    return server;
  }, options);
  t.after(async () => { await handler.close(); cache.close(); });
  return { handler, calls };
}

async function started(calls, ...queries) {
  while (queries.some(query => !calls.has(query))) await new Promise(resolve => setImmediate(resolve));
}

test('legacy cancellation only aborts the matching RPC in the matching session', { timeout: 5000 }, async t => {
  const { handler, calls } = setup(t);
  const first = await connect(handler);
  const second = await connect(handler);
  const cancelled = request(handler, call(1, 'cancel'), first);
  const sameSession = request(handler, call(2, 'keep-a'), first);
  const otherSession = request(handler, call(1, 'keep-b'), second);
  await started(calls, 'cancel', 'keep-a', 'keep-b');
  const duplicate = await request(handler, call(1, 'duplicate'), first);
  assert.equal(duplicate.status, 400);
  assert.equal(calls.has('duplicate'), false);
  const notification = await request(handler, {
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 },
  }, first);
  assert.equal(notification.status, 202);
  assert.equal((await cancelled).status, 202);
  await calls.get('cancel').aborted;
  for (const query of ['keep-a', 'keep-b']) {
    assert.equal(calls.get(query).signal.aborted, false);
    calls.get(query).resolve({ results: [] });
  }
  for (const response of await Promise.all([sameSession, otherSession])) {
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result.structuredContent.results, []);
  }
  assert.equal((await request(handler, list, first)).status, 200);
});

test('legacy disconnect and shutdown cancel pending calls and release their HTTP responses', { timeout: 5000 }, async t => {
  const { handler, calls } = setup(t);
  const session = await connect(handler);
  const controller = new AbortController();
  const disconnected = request(handler, call(1, 'disconnect'), session, { signal: controller.signal });
  const remaining = request(handler, call(2, 'shutdown'), session);
  await started(calls, 'disconnect', 'shutdown');
  controller.abort();
  assert.equal((await disconnected).status, 202);
  await calls.get('disconnect').aborted;
  assert.equal(calls.get('shutdown').signal.aborted, false);
  assert.equal((await request(handler, list, session)).status, 200);
  await Promise.all([handler.close(), handler.close()]);
  const response = await remaining;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).error.message, 'HTTP session closed.');
  await calls.get('shutdown').aborted;
  assert.equal((await request(handler, initialize)).status, 503);
});

for (const method of ['delete', 'shutdown']) {
  test(`legacy ${method} immediately rejects a real client's pending call`, { timeout: 5000 }, async t => {
    const { handler, calls } = setup(t);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    });
    const client = new Client({ name: 'test', version: '1' });
    t.after(() => client.close());
    await client.connect(transport);
    const pending = client.callTool({ name: 'search', arguments: { query: method } });
    const rejected = assert.rejects(pending, /HTTP session closed/);
    await started(calls, method);
    if (method === 'delete') await transport.terminateSession();
    else await handler.close();
    await rejected;
    await calls.get(method).aborted;
  });
}

test('legacy session capacity, idle expiry and DELETE release sessions', { timeout: 5000 }, async t => {
  let now = 0;
  const { handler, calls } = setup(t, { maxSessions: 1, idleMs: 100, now: () => now });
  const session = await connect(handler);
  assert.equal((await request(handler, initialize)).status, 503);
  assert.equal((await request(handler, list)).status, 400);
  const pending = request(handler, call(1, 'active'), session);
  await started(calls, 'active');
  now = 100;
  assert.equal((await request(handler, list, session)).status, 200);
  assert.equal(calls.get('active').signal.aborted, false);
  calls.get('active').resolve({ results: [] });
  assert.equal((await pending).status, 200);
  now = 200;
  assert.equal((await request(handler, list, session)).status, 404);
  const next = await connect(handler);
  const deleted = await handler.fetch(new Request(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': next } }));
  assert.equal(deleted.status, 200);
  assert.equal((await request(handler, list, next)).status, 404);
  const invalid = await request(handler, { ...initialize, params: {} });
  assert.ok((await invalid.json()).error);
  assert.equal(invalid.headers.has('mcp-session-id'), false);
  await connect(handler);
});

test('shutdown drains an initializing session without expiring it as idle', { timeout: 5000 }, async t => {
  let now = 0;
  const gate = Promise.withResolvers();
  const connecting = Promise.withResolvers();
  const { handler } = setup(t, { maxSessions: 1, idleMs: 100, now: () => now }, server => {
    const connect = server.connect.bind(server);
    server.connect = async transport => {
      connecting.resolve();
      await gate.promise;
      await connect(transport);
    };
  });
  const pending = request(handler, initialize);
  await connecting.promise;
  now = 100;
  assert.equal((await request(handler, initialize)).status, 503);
  let stopped = false;
  const closing = handler.close().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  gate.resolve();
  assert.equal((await pending).status, 503);
  await closing;
});

test('search batch capacity failures preserve existing cursors', { timeout: 5000 }, async t => {
  for (const maxEntries of [1, 2]) {
    const cache = new ContentCache({ maxEntries });
    t.after(() => cache.close());
    const prior = cache.store({ url: 'https://example.org', title: 'Old', content: 'abcdef' }, 2);
    const documents = ['first', 'second'].map(title => ({ url: `https://example.com/${title}`, title, content: '12345' }));
    const handler = createHttpHandler(() => createServer({ search: async () => ({ results: documents }) }, cache));
    t.after(() => handler.close());
    const session = await connect(handler);
    const response = await request(handler, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'search', arguments: { query: 'batch', need_content: true, max_length: 2 },
      },
    }, session);
    const result = (await response.json()).result;
    if (maxEntries === 1) {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /CACHE_MAX_ENTRIES/);
      assert.equal(cache.read(prior.pagination.next_cursor).content, 'cdef');
    } else {
      assert.ok(!result.isError);
      for (const page of result.structuredContent.results) {
        assert.equal(page.content, '12');
        assert.equal(cache.read(page.pagination.next_cursor).content, '345');
      }
    }
  }
});
