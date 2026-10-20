import { setTimeout as sleep } from 'node:timers/promises';
import * as z from 'zod/v4';

export const searchResponse = z.looseObject({
  results: z.array(z.looseObject({
    url: z.string(),
    title: z.string(),
    content: z.string(),
  })),
});
const fetchResponse = z.object({ title: z.string(), content: z.string() });
export type SearchRequest = {
  query: string;
  count?: number;
  ori_question?: string | null;
  localization?: string;
  need_content?: boolean;
};
type ApiOptions = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof globalThis.fetch;
};

export class DeepSeek {
  readonly #options: Required<ApiOptions>;

  constructor(options: ApiOptions) {
    if (!options.apiKey.trim()) throw new Error('DEEPSEEK_API_KEY is required.');
    this.#options = {
      baseUrl: 'https://api.deepseek.com/',
      timeoutMs: 30_000,
      retries: 2,
      fetch: globalThis.fetch,
      ...options,
    };
    if (!Number.isInteger(this.#options.timeoutMs) || this.#options.timeoutMs < 1 || this.#options.timeoutMs > 2_147_483_647) {
      throw new Error('REQUEST_TIMEOUT_MS must be an integer between 1 and 2147483647.');
    }
    const url = new URL(this.#options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('DEEPSEEK_BASE_URL must be an HTTP(S) URL without credentials.');
    }
  }

  async search(request: SearchRequest, signal: AbortSignal) {
    return searchResponse.parse(await this.#request('search', request, signal));
  }

  async fetch(url: string, signal: AbortSignal) {
    return fetchResponse.parse(await this.#request('fetch', { url }, signal));
  }

  async #request(tool: string, body: object, callerSignal: AbortSignal): Promise<unknown> {
    const options = this.#options;
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(options.timeoutMs)]);
    const url = new URL(`/v1/tools/${tool}`, options.baseUrl);
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const response = await options.fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
          redirect: 'error',
        });
        if (response.ok) return await response.json();
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= options.retries) {
          let message: string;
          try {
            message = await response.text();
          } catch {
            signal.throwIfAborted();
            message = 'Could not read the error response body.';
          }
          let detail = message.slice(0, 1000);
          try {
            const parsed = JSON.parse(message);
            if (typeof parsed.error?.message === 'string') detail = parsed.error.message.slice(0, 1000);
          } catch {}
          throw new Error(`DeepSeek ${tool} failed (HTTP ${response.status}): ${detail}`);
        }
        await response.body?.cancel().catch(() => {});
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const delay = retryAfter === null ? NaN : Number.isFinite(seconds)
          ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        const wait = Number.isFinite(delay) ? Math.max(0, delay) : 500 * 2 ** attempt;
        await sleep(Math.min(wait, 2_147_483_647), undefined, { signal });
      }
    } catch (error) {
      if (callerSignal.aborted) throw new Error('Request cancelled.');
      if (signal.aborted) throw new Error(`DeepSeek ${tool} timed out after ${options.timeoutMs} ms.`);
      if (error instanceof Error) {
        throw new Error(error.message.replaceAll(options.apiKey, '[redacted]'));
      }
      throw new Error(`DeepSeek ${tool} request failed.`);
    }
  }
}
