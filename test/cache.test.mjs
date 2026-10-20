import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentCache } from '../dist/cache.js';

const document = content => ({ url: 'https://example.com', title: 'Example', content });

test('pagination preserves Unicode and replays the same snapshot', t => {
  const cache = new ContentCache();
  t.after(() => cache.close());
  const input = document('A😀한𝄞Z');
  const first = cache.store(input, 2);
  assert.equal(first.content, 'A😀');
  assert.equal(first.pagination.total_length, 5);
  assert.equal(first.pagination.returned_length, 2);
  const cursor = first.pagination.next_cursor;
  const second = cache.read(cursor, 2);
  assert.deepEqual(cache.read(cursor, 2), second);
  const last = cache.read(second.pagination.next_cursor, 2);
  assert.equal(first.content + second.content + last.content, input.content);
  assert.equal(last.pagination.next_cursor, null);
  assert.equal(last.pagination.expires_at, first.pagination.expires_at);
  const changed = cursor.replace(/\.\d+\./, '.1.');
  assert.throws(() => cache.read(changed), /Invalid cursor/);
});

test('reading does not extend the fixed expiry', t => {
  let now = 0;
  const cache = new ContentCache({ ttlMs: 100, now: () => now });
  t.after(() => cache.close());
  const { pagination } = cache.store(document('abcdef'), 2);
  now = 99;
  assert.equal(cache.read(pagination.next_cursor, 2).content, 'cd');
  now = 100;
  assert.throws(() => cache.read(pagination.next_cursor), /expired or was evicted/);
});

test('entry and byte limits evict least recently read snapshots', t => {
  for (const options of [{ maxEntries: 2 }, { maxBytes: 150 }]) {
    const cache = new ContentCache(options);
    t.after(() => cache.close());
    const first = cache.store(document('abcdefghij'), 2);
    const second = cache.store(document('klmnopqrst'), 2);
    cache.read(first.pagination.next_cursor);
    cache.store(document('uvwxyz1234'), 2);
    assert.throws(() => cache.read(second.pagination.next_cursor), /evicted/);
    assert.equal(cache.read(first.pagination.next_cursor).content, 'cdefghij');
  }
});

test('oversized snapshots do not evict retained pages', t => {
  const cache = new ContentCache({ maxBytes: 150 });
  t.after(() => cache.close());
  const first = cache.store(document('abcdef'), 2);
  assert.throws(() => cache.store(document('x'.repeat(200)), 2), /CACHE_MAX_BYTES/);
  assert.equal(cache.read(first.pagination.next_cursor).content, 'cdef');
  const complete = cache.store(document('x'.repeat(200)), 200);
  assert.equal(complete.pagination.next_cursor, null);
  assert.equal(complete.pagination.expires_at, null);
});

test('batches admit all retained pages atomically', t => {
  const cache = new ContentCache({ maxEntries: 1 });
  t.after(() => cache.close());
  const prior = cache.store(document('abcdef'), 2);
  assert.throws(() => cache.storeBatch([document('first-content'), document('second-content')], 2), /CACHE_MAX_ENTRIES/);
  assert.equal(cache.read(prior.pagination.next_cursor).content, 'cdef');
});

test('an oversized batch does not evict an existing snapshot', t => {
  const cache = new ContentCache({ maxBytes: 150 });
  t.after(() => cache.close());
  const prior = cache.store(document('abcdef'), 2);
  const content = 'x'.repeat(40);
  assert.throws(() => cache.storeBatch([document(content), document(content)], 2), /CACHE_MAX_BYTES/);
  assert.equal(cache.read(prior.pagination.next_cursor).content, 'cdef');
});

test('complete pages are excluded from batch cache limits', t => {
  const cache = new ContentCache({ maxEntries: 1, maxBytes: 70 });
  t.after(() => cache.close());
  const pages = cache.storeBatch([document('xy'), document('abcdef')], 2);
  assert.equal(pages[0].pagination.next_cursor, null);
  assert.equal(cache.read(pages[1].pagination.next_cursor).content, 'cdef');
});

test('invalid expiry leaves retained pages unchanged', t => {
  const maxDate = 8_640_000_000_000_000;
  let now = 0;
  const cache = new ContentCache({ ttlMs: 100, now: () => now });
  t.after(() => cache.close());
  const prior = cache.store(document('abcdef'), 2);
  now = maxDate;
  assert.throws(() => cache.storeBatch([document('new-content')], 2), /Date range/);
  now = 0;
  assert.equal(cache.read(prior.pagination.next_cursor).content, 'cdef');
});

test('TTL values outside the Date range are rejected at construction', () => {
  assert.throws(() => new ContentCache({ ttlMs: 8_640_000_000_000_001 }), /Date range/);
  assert.throws(() => new ContentCache({ ttlMs: 8_640_000_000_000_000, now: () => 1 }), /Date range/);
});
