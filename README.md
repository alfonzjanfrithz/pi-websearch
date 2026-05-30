# pi-websearch

Web search and URL content fetching tools for [Pi](https://pi.dev) coding agent.

Adapted from [opencode](https://github.com/sst/opencode)'s [`websearch.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/websearch.ts), [`mcp-websearch.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/mcp-websearch.ts), and [`webfetch.ts`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/webfetch.ts).

Registers two LLM-callable tools:

- **`websearch`** — search the web via one of 6 providers: [Brave](https://brave.com/search/api/), [Tavily](https://tavily.com), [Google](https://developers.google.com/custom-search), [SearXNG](https://searxng.org), [Exa](https://exa.ai), or [Parallel](https://parallel.ai)
- **`webfetch`** — direct HTTP fetch + HTML→markdown conversion

## Install

```bash
pi install npm:@alfonzjanfrithz/pi-websearch
# or from GitHub
pi install git:github.com/alfonzjanfrithz/pi-websearch
```

## Configuration

### Search providers

| Variable | Description | Required |
|---|---|---|
| `BRAVE_API_KEY` | [Brave Search API](https://brave.com/search/api/) key | No — optional |
| `TAVILY_API_KEY` | [Tavily Search API](https://tavily.com) key | No — optional |
| `GOOGLE_API_KEY` | [Google Custom Search JSON API](https://developers.google.com/custom-search) key | No — optional (requires `GOOGLE_CX`) |
| `GOOGLE_CX` | Google Programmable Search Engine ID | No — optional (requires `GOOGLE_API_KEY`) |
| `SEARXNG_BASE_URL` | [SearXNG](https://searxng.org) instance URL (e.g. `https://searx.be`) | No — optional |
| `EXA_API_KEY` | [Exa](https://exa.ai) API key | No — works without |
| `PARALLEL_API_KEY` | [Parallel](https://parallel.ai) API key | No — works without |
| `PI_WEBSEARCH_PROVIDER` | Force a provider: `brave`, `tavily`, `google`, `searxng`, `exa`, or `parallel` | No — auto-selects |

Provider selection logic:

1. `PI_WEBSEARCH_PROVIDER` override → that provider
2. No override set → pick the highest-priority provider with configured credentials:
   - `BRAVE_API_KEY` → Brave
   - `TAVILY_API_KEY` → Tavily
   - `GOOGLE_API_KEY` + `GOOGLE_CX` → Google
   - `SEARXNG_BASE_URL` → SearXNG
3. No keys configured → deterministic hash of session ID → 50/50 split between Exa and Parallel

**Fallback** — If a provider fails (invalid key, rate limit, timeout, server error), the tool automatically tries the next available provider in the priority chain.

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

**Metadata extraction** — When fetching HTML pages, `webfetch` automatically extracts structured metadata and includes it in the result:

| Field | Source |
|---|---|
| `title` | OpenGraph (`og:title`) → JSON-LD `headline` → `<title>` → meta description |
| `description` | OpenGraph (`og:description`) → JSON-LD `description` → HTML meta description |
| `author` | OpenGraph (`og:article:author`) → JSON-LD `author`/`creator` → HTML meta author |
| `publishedDate` | OpenGraph (`og:article:published_time`) → JSON-LD `datePublished` → HTML meta date |
| `canonicalUrl` | OpenGraph (`og:url`) → `<link rel="canonical">` |
| `image` | OpenGraph (`og:image`) → JSON-LD `image` |
| `siteName` | OpenGraph (`og:site_name`) |
| `type` | OpenGraph (`og:type`) → JSON-LD `@type` |

## Features

- 6 search providers with automatic fallback on failure
- Direct HTTP fetch with browser-like User-Agent
- HTML→markdown via `turndown`, text extraction via `htmlparser2`
- Cloudflare bot detection retry (honest UA fallback)
- Image support (returned as base64 attachments)
- Output truncation (50KB / 2000 lines, overflow saved to temp file)
- Automatic page metadata extraction (OpenGraph, JSON-LD structured data, HTML meta tags)

## Testing

A test script is included to verify each provider works:

```bash
# Test all configured providers
node test-providers.mjs

# Test a single provider
node test-providers.mjs brave
node test-providers.mjs tavily
node test-providers.mjs google
node test-providers.mjs searxng
node test-providers.mjs exa
node test-providers.mjs parallel

# Test with environment variables inline
BRAVE_API_KEY=your-key node test-providers.mjs brave
SEARXNG_BASE_URL=https://your-instance.com node test-providers.mjs searxng
```

**Note:** Public SearXNG instances often disable the JSON API or rate-limit it. For best results, [self-host SearXNG](https://docs.searxng.org/admin/installation.html) and enable `json` in `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

## License

MIT
