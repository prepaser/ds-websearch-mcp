import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const content = '😀'.repeat(5001) + 'tail';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

for (const mode of ['stdio', 'http', 'legacy-http']) {
  test(`${mode}: actual CLI supports paginated search and fetch`, { timeout: 15_000 }, async t => {
    const requests = [];
    const cancellation = { started: Promise.withResolvers(), closed: Promise.withResolvers() };
    const upstream = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ path: req.url, body });
      if (body.query === 'wait-cancel') {
        res.once('close', () => cancellation.closed.resolve());
        cancellation.started.resolve();
        return;
      }
      if (body.query === 'no-balance') {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Insufficient balance' } }));
        return;
      }
      const page = { url: 'https://example.com', title: 'Example', content };
      const result = req.url.endsWith('/search')
        ? { results: [{ ...page, content: body.need_content ? content : '', rerank_score: 2.4, date: null }] }
        : { title: page.title, content };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    const upstreamPort = await listen(upstream);
    t.after(() => new Promise(resolve => upstream.close(resolve)));
    const env = {
      ...process.env,
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    };
    let transport;
    let endpoint;
    if (mode === 'stdio') {
      transport = new StdioClientTransport({ command: process.execPath, args: [cli], env });
    } else {
      const probe = createServer();
      const port = await listen(probe);
      await new Promise(resolve => probe.close(resolve));
      const child = spawn(process.execPath, [cli, '--transport', 'http', '--port', String(port)], { env });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      const ready = new Promise((resolve, reject) => {
        child.stderr.on('data', text => {
          stderr += text;
          if (stderr.includes('Listening on')) resolve();
        });
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`HTTP server exited (${code}): ${stderr}`)));
      });
      t.after(async () => {
        if (child.exitCode !== null) return;
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      });
      await ready;
      endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
      transport = new StreamableHTTPClientTransport(endpoint);
    }
    const client = new Client({ name: 'integration', version: '1.0.0' }, mode === 'http'
      ? { versionNegotiation: { mode: 'auto' } } : {});
    t.after(() => client.close());
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['fetch', 'search']);
    assert.equal(tools.find(tool => tool.name === 'search').inputSchema.properties.query.maxLength, undefined);

    const search = await client.callTool({ name: 'search', arguments: {
      query: 'q'.repeat(129), count: 55, ori_question: 'o'.repeat(129), need_content: true,
    } });
    assert.ok(!search.isError, JSON.stringify(search));
    const hit = search.structuredContent.results[0];
    assert.equal(hit.rerank_score, 2.4);
    assert.equal(hit.date, null);
    assert.equal(hit.content, '😀'.repeat(5000));
    assert.equal(hit.pagination.returned_length, 5000);
    assert.equal(hit.pagination.total_length, 5005);
    assert.equal(requests[0].body.query.length, 129);
    assert.equal(requests[0].body.count, 55);
    assert.equal(requests[0].body.max_length, undefined);

    const continued = await client.callTool({ name: 'fetch', arguments: { cursor: hit.pagination.next_cursor } });
    assert.ok(!continued.isError, JSON.stringify(continued));
    assert.equal(continued.structuredContent.content, '😀tail');
    assert.equal(continued.structuredContent.pagination.next_cursor, null);
    assert.equal(requests.length, 1);

    const fetched = await client.callTool({ name: 'fetch', arguments: { url: 'https://example.com' } });
    assert.ok(!fetched.isError, JSON.stringify(fetched));
    const cursor = fetched.structuredContent.pagination.next_cursor;
    const rest = await client.callTool({ name: 'fetch', arguments: { cursor, max_length: 2 } });
    assert.equal(rest.structuredContent.content, '😀t');
    const restAgain = await client.callTool({ name: 'fetch', arguments: { cursor, max_length: 2 } });
    assert.deepEqual(restAgain.structuredContent, rest.structuredContent);
    assert.equal(requests.length, 2);

    const invalid = await client.callTool({ name: 'fetch', arguments: { url: 'https://example.com', cursor } });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, 2);
    const failed = await client.callTool({ name: 'search', arguments: { query: 'no-balance' } });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /HTTP 402/);
    assert.equal(requests.length, 3);

    const controller = new AbortController();
    const pending = client.callTool({ name: 'search', arguments: { query: 'wait-cancel' } }, { signal: controller.signal });
    const cancelled = assert.rejects(pending);
    await cancellation.started.promise;
    controller.abort();
    await cancelled;
    await cancellation.closed.promise;
    assert.equal((await client.listTools()).tools.length, 2);

    if (endpoint) {
      const rejected = await fetch(endpoint, { headers: { Origin: 'https://example.org' } });
      assert.equal(rejected.status, 403);
    }
  });
}
