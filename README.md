# pi-websearch

Web search and URL content fetching tools for [Pi](https://pi.dev) coding agent.

Adapted from [opencode](https://github.com/sst/opencode)'s [`websearch.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/websearch.ts), [`mcp-websearch.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/mcp-websearch.ts), and [`webfetch.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/webfetch.ts).

Registers two LLM-callable tools:

- **`websearch`** — search the web via [Exa](https://exa.ai) or [Parallel](https://parallel.ai) (MCP JSON-RPC)
- **`webfetch`** — direct HTTP fetch + HTML→markdown conversion

## Install

```bash
pi install npm:pi-websearch
# or from GitHub
pi install git:github.com/alfonzjanfrithz/pi-websearch
```

## Configuration

### Search providers

| Variable | Description | Required |
|---|---|---|
| `EXA_API_KEY` | [Exa](https://exa.ai) API key | No — works without |
| `PARALLEL_API_KEY` | [Parallel](https://parallel.ai) API key | No — works without |
| `PI_WEBSEARCH_PROVIDER` | Force a provider: `exa` or `parallel` | No — auto-selects |

Provider selection logic (matches opencode):

1. `PI_WEBSEARCH_PROVIDER` override → that provider
2. No override set → deterministic hash of session ID → 50/50 split between Exa and Parallel

### Web fetch

No API keys needed. Fetches URLs directly, converts HTML to markdown using `turndown`. No third-party services.

## Tools

### `websearch`

Search the web and return relevant content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | Search query |
| `numResults` | number | no | Number of results (default: 8) |

### `webfetch`

Fetch a URL and extract its content.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | URL to fetch |
| `format` | `"text"` \| `"markdown"` \| `"html"` | no | Output format (default: `"markdown"`) |
| `timeout` | number | no | Timeout in seconds (max 120) |

## Features

- Direct HTTP fetch with browser-like User-Agent
- HTML→markdown via `turndown`, text extraction via `htmlparser2`
- Cloudflare bot detection retry (honest UA fallback)
- Image support (returned as base64 attachments)
- Output truncation (50KB / 2000 lines, overflow saved to temp file)

## License

MIT
