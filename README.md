# ds-websearch-mcp

A simple MCP server for [DeepSeek Search and Fetch](https://api-docs.deepseek.com/guides/search).

## Quick Start

Requires Node.js 24 or later and a DeepSeek API key.

Add the following to your MCP client configuration, replacing the API key. `npx` downloads and runs the package automatically:

```json
{
  "mcpServers": {
    "ds-websearch-mcp": {
      "command": "npx",
      "args": ["-y", "ds-websearch-mcp"],
      "env": {
        "DEEPSEEK_API_KEY": "your-api-key"
      }
    }
  }
}
```

Restart your MCP client to load the `search` and `fetch` tools.

### Codex

Run with your API key:

```sh
codex mcp add ds-websearch-mcp --env DEEPSEEK_API_KEY=your-api-key -- npx -y ds-websearch-mcp
```

Or add the following to `~/.codex/config.toml`:

```toml
[mcp_servers.ds-websearch-mcp]
command = "npx"
args = ["-y", "ds-websearch-mcp"]

[mcp_servers.ds-websearch-mcp.env]
DEEPSEEK_API_KEY = "your-api-key"
```

Restart Codex to load the tools.

### HTTP

Run the server on the loopback interface:

```sh
DEEPSEEK_API_KEY=your-api-key npx -y ds-websearch-mcp --transport http --port 3000
```

Connect an MCP client to `http://127.0.0.1:3000/mcp`.

## Tools

### `search`

| Parameter | Default | Description |
| --- | --- | --- |
| `query` | Required | Search query, including operators such as `site:`, `lang:`, `after:`, and `before:`. |
| `count` | API default: `10` | Number of results. |
| `ori_question` | Omitted | Original question, when useful for query understanding. |
| `localization` | Omitted | Optional IP address used to localize results. |
| `need_content` | `false` | Include page content. |
| `max_length` | `5000` | Maximum Unicode characters of page content per result. |

Preserves upstream fields and ranking, including summaries, relevance scores, dates, and authority. Nonempty page content receives a `pagination` object. `max_length` applies to page content, not summaries or the total JSON response.

When a search returns page content, all pages that need caching are admitted as one batch. If the batch exceeds the configured entry or byte capacity, the tool returns an error and keeps existing cursors valid. Reduce `count`, increase `max_length` so more pages are returned completely, or increase the cache capacity.

DeepSeek currently documents 1–128 characters for `query` and `ori_question`, and 1–50 for `count`.

### `fetch`

| Parameter | Default | Description |
| --- | --- | --- |
| `url` | Omitted | Page URL to retrieve from DeepSeek. |
| `cursor` | Omitted | `pagination.next_cursor` returned by either tool. |
| `max_length` | `5000` | Maximum Unicode characters of page content to return. |

Supply exactly one of `url` and `cursor`. Returns `url`, `title`, `content`, and `pagination`:

```json
{
  "returned_length": 5000,
  "total_length": 12400,
  "next_cursor": "opaque-cursor",
  "expires_at": "2026-10-20T12:15:00.000Z"
}
```

Pass `next_cursor` to `fetch` to continue. A null cursor means the end of the page. Unicode code points count as characters; surrogate pairs are never split. Cursor reads use the same saved snapshot, make no additional DeepSeek requests, and can be replayed. `max_length` can change between reads.

Only pages with remaining content are retained. Expiry is fixed when stored and is not extended by reading. Least recently read snapshots are evicted when the entry or byte limit is reached. Cursors expire with their snapshot and do not survive process restarts; an expired or evicted cursor returns a tool error asking the caller to fetch the URL again. Final-page reads keep the snapshot available until expiry or eviction for reliable retries.

A page larger than the cache capacity cannot be retained and returns an explicit error. Increase `CACHE_MAX_BYTES` or request a `max_length` large enough to return the full page. The byte limit accounts for retained text as UTF-16; it is not a limit on total process memory. HTTP requests share one process-local cache; cursors are signed and contain an unguessable snapshot identifier.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | Required | DeepSeek bearer token. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/` | API origin, useful for gateways or local testing. Requests use `/v1/tools/search` and `/v1/tools/fetch`. |
| `REQUEST_TIMEOUT_MS` | `30000` | Total deadline per API call, including retries and response reading. Maximum: `2147483647` ms. |
| `CACHE_TTL_MS` | `43200000` | Fixed snapshot lifetime: 12 hours. Values outside the JavaScript `Date` range are rejected at startup and when a snapshot is stored. |
| `CACHE_MAX_BYTES` | `268435456` | Retained text capacity: 256 MiB. |
| `CACHE_MAX_ENTRIES` | `256` | Maximum retained snapshots. |
| `HTTP_MAX_SESSIONS` | `64` | Maximum concurrent legacy HTTP sessions. |
| `HTTP_SESSION_IDLE_MS` | `1800000` | Idle lifetime for legacy HTTP sessions: 30 minutes. Sessions with active requests are not expired. |

## Development

From a source checkout:

```sh
npm ci
npm run build
npm run check
npm test
npm pack --dry-run
```

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
