import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ContentCache } from './cache.js';
import { DeepSeek, searchResponse } from './deepseek.js';

const maxLength = z.number().int().positive().default(5000)
  .describe('Maximum Unicode characters of page content to return. Default: 5000.');
const pagination = z.object({
  returned_length: z.number(),
  total_length: z.number(),
  next_cursor: z.string().nullable(),
  expires_at: z.string().nullable(),
});
const pageOutput = z.object({
  url: z.string(),
  title: z.string(),
  content: z.string(),
  pagination,
});
const searchOutput = searchResponse.extend({
  results: z.array(searchResponse.shape.results.element.extend({
    pagination: pagination.optional(),
  })),
});
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function result<T extends Record<string, unknown>>(data: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data };
}

export function createServer(api: DeepSeek, cache: ContentCache) {
  const server = new McpServer({ name: 'ds-websearch-mcp', version: '0.1.0' });
  server.registerTool('search', {
    description: 'Search the web using DeepSeek. Supports site:, -site:, quoted phrases, lang:, after:, and before:. The API currently documents a 128-character query limit. Page content is optional and paginated; read more with fetch(cursor).',
    inputSchema: z.object({
      query: z.string().describe('Search query; the API currently documents 1–128 Unicode characters.'),
      count: z.number().int().optional().describe('Number of results. API default: 10; documented range: 1–50.'),
      ori_question: z.string().nullable().optional().describe('Optional original question. The API currently documents 1–128 characters.'),
      localization: z.string().optional().describe('Optional IP address used to localize results. Not sent unless provided.'),
      need_content: z.boolean().default(false).describe('Include page content, paginated per result. Default: false.'),
      max_length: maxLength,
    }),
    outputSchema: searchOutput,
    annotations,
  }, async ({ max_length, ...request }, ctx) => {
    const response = await api.search(request, ctx.mcpReq.signal);
    const pages = cache.storeBatch(response.results.filter(item => item.content), max_length);
    let pageIndex = 0;
    const results = response.results.map(item => {
      if (!item.content) return item;
      const page = pages[pageIndex++]!;
      return { ...item, content: page.content, pagination: page.pagination };
    });
    return result({ ...response, results });
  });

  server.registerTool('fetch', {
    description: 'Read a web page as Markdown, or continue a cached page using next_cursor from search or fetch. Supply exactly one of url or cursor. Cursors read the same saved snapshot without another API request; they can expire or be evicted.',
    inputSchema: z.object({
      url: z.string().optional().describe('Page URL. The API currently accepts HTTP(S) URLs up to 8192 characters, without credentials.'),
      cursor: z.string().optional().describe('next_cursor from a previous result. Omit url when continuing.'),
      max_length: maxLength,
    }).refine(args => (args.url !== undefined) !== (args.cursor !== undefined), {
      message: 'Supply exactly one of url or cursor.',
    }),
    outputSchema: pageOutput,
    annotations,
  }, async ({ url, cursor, max_length }, ctx) => {
    if (cursor !== undefined) return result(cache.read(cursor, max_length));
    const page = await api.fetch(url!, ctx.mcpReq.signal);
    return result(cache.store({ url: url!, ...page }, max_length));
  });
  return server;
}
