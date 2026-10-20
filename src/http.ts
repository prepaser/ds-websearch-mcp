import { randomUUID } from 'node:crypto';
import {
  createMcpHandler, InMemoryTransport, isInitializeRequest, isJSONRPCNotification,
  isJSONRPCRequest, isJSONRPCResponse, isJsonContentType, isLegacyRequest,
  parseJSONRPCMessage, readRequestBody, SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/server';
import type { JSONRPCMessage, JSONRPCResponse, McpServer, RequestId } from '@modelcontextprotocol/server';

type Pending = { method: string; finish: (response?: JSONRPCResponse) => void };
type Session = {
  server: McpServer;
  wire: InMemoryTransport;
  pending: Map<RequestId, Pending>;
  lastActive: number;
  closed: boolean;
  starting?: Promise<void>;
  closing?: Promise<void>;
};
type HttpOptions = { maxSessions?: number; idleMs?: number; now?: () => number };

function error(status: number, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code, message } }, { status });
}

export function createHttpHandler(factory: () => McpServer, options: HttpOptions = {}) {
  const maxSessions = options.maxSessions ?? 64;
  const idleMs = options.idleMs ?? 30 * 60_000;
  const now = options.now ?? Date.now;
  for (const value of [maxSessions, idleMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('HTTP session limits must be positive safe integers.');
  }
  const modern = createMcpHandler(factory, { legacy: 'reject' });
  const sessions = new Map<string, Session>();
  const draining = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function closeSession(id: string, session: Session) {
    if (!session.closing) {
      session.closed = true;
      if (sessions.get(id) === session) sessions.delete(id);
      const closing = (async () => {
        await session.starting?.catch(() => {});
        await session.server.close();
      })();
      session.closing = closing;
      draining.add(closing);
      void closing.finally(() => draining.delete(closing)).catch(() => {});
    }
    return session.closing;
  }

  function prune() {
    for (const [id, session] of sessions) {
      if (!session.starting && session.pending.size === 0 && now() - session.lastActive >= idleMs) {
        void closeSession(id, session).catch(console.error);
      }
    }
  }
  const timer = setInterval(prune, Math.min(idleMs, 30_000));
  timer.unref();

  function cancel(session: Session, id: RequestId) {
    const pending = session.pending.get(id);
    if (!pending || pending.method === 'initialize') return;
    void session.wire.send({
      jsonrpc: '2.0', method: 'notifications/cancelled',
      params: { requestId: id, reason: 'HTTP request cancelled' },
    }).catch(() => {});
    pending.finish();
  }

  async function legacy(request: Request): Promise<Response> {
    if (closed) return error(503, -32000, 'Server is shutting down.');
    const version = request.headers.get('mcp-protocol-version');
    if (version && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      return error(400, -32000, 'Unsupported MCP protocol version.');
    }
    const knownId = request.headers.get('mcp-session-id');
    if (knownId && !sessions.has(knownId)) return error(404, -32001, 'Session expired or not found. Initialize a new session.');
    if (request.method === 'GET') return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
    if (!['POST', 'DELETE'].includes(request.method)) return error(405, -32000, 'Method not allowed.');

    let messages: JSONRPCMessage[] = [];
    let batch = false;
    if (request.method === 'POST') {
      const accept = request.headers.get('accept')?.toLowerCase() ?? '';
      if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
        return error(406, -32000, 'Accept must include application/json and text/event-stream.');
      }
      try {
        const body = await readRequestBody(request);
        if (body.tooLarge) return error(413, -32000, 'Request body is too large.');
        const parsed: unknown = JSON.parse(body.text);
        batch = Array.isArray(parsed);
        const values = batch ? parsed as unknown[] : [parsed];
        if (values.length === 0 || values.length > 100) return error(400, -32600, 'Invalid request batch.');
        messages = values.map(parseJSONRPCMessage);
      } catch {
        return error(400, -32700, 'Invalid JSON-RPC request.');
      }
    }
    if (closed) return error(503, -32000, 'Server is shutting down.');
    const initializing = messages.length === 1 && isInitializeRequest(messages[0]);
    let id = request.headers.get('mcp-session-id');
    let session = id ? sessions.get(id) : undefined;
    if (id && !session) return error(404, -32001, 'Session expired or not found. Initialize a new session.');
    if (!session) {
      if (!initializing) return error(400, -32000, 'Mcp-Session-Id is required.');
      if (sessions.size >= maxSessions) return error(503, -32000, 'HTTP session limit reached.');
      id = randomUUID();
      const [wire, serverWire] = InMemoryTransport.createLinkedPair();
      const server = factory();
      session = { server, wire, pending: new Map(), lastActive: now(), closed: false };
      const created = session;
      const sessionId = id;
      wire.onmessage = message => {
        if (isJSONRPCResponse(message) && message.id !== undefined) created.pending.get(message.id)?.finish(message);
      };
      wire.onclose = () => {
        created.closed = true;
        if (sessions.get(sessionId) === created) sessions.delete(sessionId);
        for (const [id, pending] of created.pending) pending.finish({
          jsonrpc: '2.0', id, error: { code: -32000, message: 'HTTP session closed.' },
        });
      };
      sessions.set(id, session);
      session.starting = (async () => {
        await server.connect(serverWire);
        await wire.start();
      })();
      try {
        await session.starting;
      } catch (cause) {
        await closeSession(id, session);
        throw cause;
      } finally {
        session.starting = undefined;
      }
      if (closed || session.closed) {
        await closeSession(id, session);
        return error(503, -32000, 'Server is shutting down.');
      }
    } else if (initializing) {
      return error(400, -32600, 'Session is already initialized.');
    }
    const current = session;
    const sessionId = id!;
    if (current.closed) return error(404, -32001, 'Session expired or not found.');
    current.lastActive = now();
    if (request.method === 'DELETE') {
      await closeSession(sessionId, current);
      return new Response(null, { status: 200 });
    }
    const requests = messages.filter(isJSONRPCRequest);
    const ids = new Set(requests.map(message => message.id));
    if (ids.size !== requests.length || [...ids].some(key => current.pending.has(key))) {
      return error(400, -32600, 'Request IDs must be unique within a session.');
    }
    const responses = requests.map(message => new Promise<JSONRPCResponse | undefined>(resolve => {
      const pending: Pending = { method: message.method, finish: response => {
        if (current.pending.get(message.id) !== pending) return;
        current.pending.delete(message.id);
        current.lastActive = now();
        resolve(response);
      } };
      current.pending.set(message.id, pending);
    }));
    const abort = () => {
      if (initializing) void closeSession(sessionId, current).catch(console.error);
      else for (const key of ids) cancel(current, key);
    };
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      for (const message of messages) {
        if (request.signal.aborted) {
          abort();
          break;
        }
        await current.wire.send(message);
        if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
          const key = message.params?.requestId;
          if (typeof key === 'string' || typeof key === 'number') {
            const pending = current.pending.get(key);
            if (pending?.method !== 'initialize') pending?.finish();
          }
        }
      }
      const results = (await Promise.all(responses)).filter(response => response !== undefined);
      if (results.length === 0) return new Response(null, { status: 202 });
      if (initializing && 'error' in results[0]!) {
        await closeSession(sessionId, current);
        return Response.json(results[0]);
      }
      return Response.json(batch ? results : results[0], { headers: { 'Mcp-Session-Id': sessionId } });
    } catch (cause) {
      abort();
      throw cause;
    } finally {
      request.signal.removeEventListener('abort', abort);
    }
  }

  return {
    async fetch(request: Request) {
      if (closed) return error(503, -32000, 'Server is shutting down.');
      prune();
      if (request.method === 'POST' && !isJsonContentType(request.headers.get('content-type'))) {
        return error(415, -32000, 'Content-Type must be application/json.');
      }
      return await isLegacyRequest(request) ? legacy(request) : modern.fetch(request);
    },
    close() {
      if (!closing) {
        closed = true;
        clearInterval(timer);
        closing = Promise.all([
          modern.close(),
          ...[...sessions].map(([id, session]) => closeSession(id, session)),
          ...draining,
        ]).then(() => {});
      }
      return closing;
    },
  };
}
