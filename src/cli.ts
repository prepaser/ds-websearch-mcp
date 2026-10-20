#!/usr/bin/env node
import { createServer as createHttpServer } from 'node:http';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { ContentCache } from './cache.js';
import { DeepSeek } from './deepseek.js';
import { createServer } from './server.js';
import { createHttpHandler } from './http.js';
import { version } from './metadata.js';

function integer(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

async function main() {
  const { values } = parseArgs({ options: {
    transport: { type: 'string', default: 'stdio' },
    port: { type: 'string', default: '3000' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  } });
  if (values.help) {
    console.log('Usage: ds-websearch-mcp [--transport stdio|http] [--port 3000]\n\nRequires DEEPSEEK_API_KEY. HTTP listens on http://127.0.0.1:PORT/mcp.');
    return;
  }
  if (values.version) {
    console.log(version);
    return;
  }
  if (!['stdio', 'http'].includes(values.transport)) throw new Error('--transport must be stdio or http.');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be between 1 and 65535.');
  const api = new DeepSeek({
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/',
    timeoutMs: integer('REQUEST_TIMEOUT_MS', 30_000),
  });
  const cache = new ContentCache({
    ttlMs: integer('CACHE_TTL_MS', 12 * 60 * 60_000),
    maxBytes: integer('CACHE_MAX_BYTES', 256 * 1024 * 1024),
    maxEntries: integer('CACHE_MAX_ENTRIES', 256),
  });
  const factory = () => createServer(api, cache);
  let close: () => Promise<void>;
  if (values.transport === 'stdio') {
    const handle = serveStdio(factory);
    close = () => handle.close();
  } else {
    const handler = createHttpHandler(factory, {
      maxSessions: integer('HTTP_MAX_SESSIONS', 64),
      idleMs: integer('HTTP_SESSION_IDLE_MS', 30 * 60_000),
    });
    const route = toNodeHandler(handler);
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const http = createHttpServer((req, res) => {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      if (req.url?.split('?')[0] !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      void route(req, res).catch(error => {
        console.error(error instanceof Error ? error.message : 'HTTP request failed.');
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, '127.0.0.1', resolve);
      });
    } catch (error) {
      await handler.close();
      cache.close();
      throw error;
    }
    console.error(`Listening on http://127.0.0.1:${port}/mcp`);
    close = async () => {
      const stopped = new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      await handler.close();
      http.closeAllConnections();
      await stopped;
    };
  }
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    cache.close();
    await close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown().catch(error => {
      console.error(error instanceof Error ? error.message : 'Shutdown failed.');
      process.exitCode = 1;
    }));
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Startup failed.');
  process.exitCode = 1;
});
