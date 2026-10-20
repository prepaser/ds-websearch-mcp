import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type Document = { url: string; title: string; content: string };
export type Pagination = {
  returned_length: number;
  total_length: number;
  next_cursor: string | null;
  expires_at: string | null;
};
export type Page = Document & { pagination: Pagination };
type Entry = Document & { length: number; bytes: number; expires: number; expiresAt: string | null };
type CacheOptions = {
  ttlMs?: number;
  maxBytes?: number;
  maxEntries?: number;
  now?: () => number;
};

function chunk(content: string, offset: number, limit: number) {
  let end = offset;
  let length = 0;
  while (end < content.length && length < limit) {
    end += content.codePointAt(end)! > 0xffff ? 2 : 1;
    length++;
  }
  return { content: content.slice(offset, end), end, length };
}

const MAX_DATE_MS = 8_640_000_000_000_000;

export class ContentCache {
  readonly #entries = new Map<string, Entry>();
  readonly #secret = randomBytes(32);
  readonly #ttlMs: number;
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #timer: NodeJS.Timeout;
  #bytes = 0;

  constructor(options: CacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 12 * 60 * 60_000;
    this.#maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.#maxEntries = options.maxEntries ?? 256;
    this.#now = options.now ?? Date.now;
    for (const value of [this.#ttlMs, this.#maxBytes, this.#maxEntries]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('Cache limits must be positive safe integers.');
      }
    }
    try {
      this.#expiration();
    } catch {
      throw new Error('CACHE_TTL_MS exceeds the supported Date range.');
    }
    this.#timer = setInterval(() => this.#prune(), Math.min(this.#ttlMs, 30_000));
    this.#timer.unref();
  }

  store(document: Document, maxLength = 5000): Page {
    return this.storeBatch([document], maxLength)[0]!;
  }

  storeBatch(documents: Document[], maxLength = 5000): Page[] {
    this.#validateLength(maxLength);
    const prepared = documents.map(document => {
      let length = 0;
      for (const _ of document.content) length++;
      const first = chunk(document.content, 0, maxLength);
      const entry: Entry = {
        url: document.url,
        title: document.title,
        content: document.content,
        length,
        bytes: 2 * (document.content.length + document.title.length + document.url.length),
        expires: 0,
        expiresAt: null,
      };
      return { entry, first, retained: first.end < document.content.length };
    });
    const retained = prepared.filter(page => page.retained);
    const bytes = retained.reduce((sum, { entry }) => sum + entry.bytes, 0);
    if (bytes > this.#maxBytes || retained.length > this.#maxEntries) {
      throw new Error('Page batch exceeds CACHE_MAX_BYTES or CACHE_MAX_ENTRIES. Increase cache capacity or max_length, or request fewer results.');
    }

    const expiration = retained.length > 0 ? this.#expiration() : null;
    const ids = prepared.map(({ retained: keep }) => keep ? this.#newId() : null);
    for (const { entry, retained: keep } of prepared) {
      if (keep) {
        entry.expires = expiration!.expires;
        entry.expiresAt = expiration!.expiresAt;
      }
    }
    const pages = prepared.map(({ entry, first }, index) => this.#page(entry, first, ids[index] ?? undefined));
    if (retained.length === 0) return pages;

    this.#prune();
    while (this.#bytes + bytes > this.#maxBytes || this.#entries.size + retained.length > this.#maxEntries) {
      this.#delete(this.#entries.keys().next().value!);
    }
    for (const [index, { entry, retained: keep }] of prepared.entries()) {
      if (!keep) continue;
      const id = ids[index]!;
      this.#entries.set(id, entry);
      this.#bytes += entry.bytes;
    }
    return pages;
  }

  read(cursor: string, maxLength = 5000): Page {
    this.#validateLength(maxLength);
    const match = /^([\w-]{24})\.(\d{1,16})\.([\w-]{43})$/.exec(cursor);
    if (!match) throw new Error('Invalid cursor. Use next_cursor from a previous result.');
    const id = match[1]!;
    const rawOffset = match[2]!;
    const signature = match[3]!;
    const payload = `${id}.${rawOffset}`;
    const expected = this.#sign(payload);
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw new Error('Invalid cursor. Use next_cursor from a previous result.');
    }
    this.#prune();
    const entry = this.#entries.get(id);
    if (!entry) throw new Error('Cursor expired or was evicted. Fetch the URL again to restart.');
    const offset = Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset >= entry.content.length) {
      throw new Error('Invalid cursor offset.');
    }
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    return this.#page(entry, chunk(entry.content, offset, maxLength), id);
  }

  close() {
    clearInterval(this.#timer);
    this.#entries.clear();
    this.#bytes = 0;
  }

  #page(entry: Entry, part: ReturnType<typeof chunk>, id?: string): Page {
    const more = part.end < entry.content.length;
    return {
      url: entry.url,
      title: entry.title,
      content: part.content,
      pagination: {
        returned_length: part.length,
        total_length: entry.length,
        next_cursor: more && id ? this.#cursor(id, part.end) : null,
        expires_at: id ? entry.expiresAt : null,
      },
    };
  }

  #cursor(id: string, offset: number) {
    const payload = `${id}.${offset}`;
    return `${payload}.${this.#sign(payload)}`;
  }

  #sign(payload: string) {
    return createHmac('sha256', this.#secret).update(payload).digest('base64url');
  }

  #validateLength(length: number) {
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new Error('max_length must be a positive safe integer.');
    }
  }

  #expiration() {
    const now = this.#now();
    const expires = now + this.#ttlMs;
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expires) || Math.abs(expires) > MAX_DATE_MS) {
      throw new Error('Cache expiry exceeds the supported Date range.');
    }
    let expiresAt: string;
    try {
      expiresAt = new Date(expires).toISOString();
    } catch {
      throw new Error('Cache expiry exceeds the supported Date range.');
    }
    return { expires, expiresAt };
  }

  #newId() {
    let id: string;
    do {
      id = randomBytes(18).toString('base64url');
    } while (this.#entries.has(id));
    return id;
  }

  #delete(id: string) {
    const entry = this.#entries.get(id)!;
    this.#bytes -= entry.bytes;
    this.#entries.delete(id);
  }

  #prune() {
    const now = this.#now();
    for (const [id, entry] of this.#entries) {
      if (entry.expires <= now) this.#delete(id);
    }
  }
}
