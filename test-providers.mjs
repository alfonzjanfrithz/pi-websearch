#!/usr/bin/env node
/**
 * Test script for pi-websearch providers.
 * Run: node test-providers.mjs [provider]
 * Examples:
 *   node test-providers.mjs          # test all available providers
 *   node test-providers.mjs brave    # test only Brave
 *   node test-providers.mjs exa      # test only Exa
 */

const TEST_QUERY = "hello world";
const MCP_TIMEOUT_MS = 25_000;

// ── Colors ──
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", D = "\x1b[2m", X = "\x1b[0m";

function ok(msg)  { console.log(`${G}✓${X} ${msg}`); }
function fail(msg) { console.log(`${R}✗${X} ${msg}`); }
function info(msg) { console.log(`${C}ℹ${X} ${msg}`); }
function dim(msg)  { console.log(`${D}${msg}${X}`); }

// ── MCP helper (same as index.ts) ──
function parseMcpResponse(body) {
  const tryParse = (payload) => {
    const trimmed = payload.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const data = JSON.parse(trimmed);
      const content = data?.result?.content;
      return content?.find((item) => item.text)?.text;
    } catch { return undefined; }
  };
  const direct = tryParse(body);
  if (direct) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = tryParse(line.substring(6));
    if (data) return data;
  }
  return undefined;
}

async function mcpCall(url, tool, args, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(headers || {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseMcpResponse(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

// ── Provider testers ──

async function testBrave() {
  const key = process.env.BRAVE_API_KEY;
  if (!key) { info("Skipped: BRAVE_API_KEY not set"); return null; }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", TEST_QUERY);
  url.searchParams.set("count", "3");
  url.searchParams.set("search_lang", "en");

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    });
    if (res.status === 401 || res.status === 403) {
      fail(`Brave — API key invalid/expired (HTTP ${res.status})`);
      return false;
    }
    if (res.status === 429) {
      fail(`Brave — rate limited (HTTP 429)`);
      return false;
    }
    if (!res.ok) {
      fail(`Brave — HTTP ${res.status}`);
      return false;
    }
    const data = await res.json();
    const results = data.web?.results ?? [];
    ok(`Brave — ${results.length} result(s)`);
    if (results[0]) dim(`  → ${results[0].title} (${results[0].url})`);
    return true;
  } catch (err) {
    fail(`Brave — ${err.message}`);
    return false;
  }
}

async function testTavily() {
  const key = process.env.TAVILY_API_KEY;
  if (!key) { info("Skipped: TAVILY_API_KEY not set"); return null; }

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        api_key: key, query: TEST_QUERY,
        search_depth: "basic", max_results: 3,
        include_answer: false, include_images: false,
      }),
    });
    if (res.status === 401 || res.status === 403) {
      fail(`Tavily — API key invalid/expired (HTTP ${res.status})`);
      return false;
    }
    if (res.status === 429) {
      fail(`Tavily — rate limited (HTTP 429)`);
      return false;
    }
    if (!res.ok) {
      fail(`Tavily — HTTP ${res.status}`);
      return false;
    }
    const data = await res.json();
    const results = data.results ?? [];
    ok(`Tavily — ${results.length} result(s)`);
    if (results[0]) dim(`  → ${results[0].title} (${results[0].url})`);
    return true;
  } catch (err) {
    fail(`Tavily — ${err.message}`);
    return false;
  }
}

async function testGoogle() {
  const key = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;
  if (!key || !cx) { info("Skipped: GOOGLE_API_KEY and/or GOOGLE_CX not set"); return null; }

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", TEST_QUERY);
  url.searchParams.set("num", "3");

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 400) {
      const body = await res.json();
      fail(`Google — API error: ${body.error?.message || "unknown"}`);
      return false;
    }
    if (res.status === 403) {
      fail(`Google — API key invalid or quota exceeded (HTTP 403)`);
      return false;
    }
    if (!res.ok) {
      fail(`Google — HTTP ${res.status}`);
      return false;
    }
    const data = await res.json();
    const items = data.items ?? [];
    ok(`Google — ${items.length} result(s)`);
    if (items[0]) dim(`  → ${items[0].title} (${items[0].link})`);
    return true;
  } catch (err) {
    fail(`Google — ${err.message}`);
    return false;
  }
}

async function testSearxng() {
  const base = process.env.SEARXNG_BASE_URL;
  if (!base) { info("Skipped: SEARXNG_BASE_URL not set"); return null; }

  const url = new URL(`${base.replace(/\/$/, "")}/search`);
  url.searchParams.set("q", TEST_QUERY);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");
  url.searchParams.set("pageno", "1");

  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 403) {
      fail(`SearXNG — JSON format disabled on this instance (HTTP 403)`);
      return false;
    }
    if (!res.ok) {
      fail(`SearXNG — HTTP ${res.status}`);
      return false;
    }
    const data = await res.json();
    const results = data.results ?? [];
    ok(`SearXNG — ${results.length} result(s)`);
    if (results[0]) dim(`  → ${results[0].title} (${results[0].url})`);
    return true;
  } catch (err) {
    fail(`SearXNG — ${err.message}`);
    return false;
  }
}

async function testExa() {
  const key = process.env.EXA_API_KEY;
  const url = key
    ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(key)}`
    : "https://mcp.exa.ai/mcp";

  try {
    const result = await mcpCall(url, "web_search_exa", {
      query: TEST_QUERY, type: "auto", numResults: 3, livecrawl: "fallback",
    });
    if (!result) { fail("Exa — empty MCP response"); return false; }
    const lines = result.trim().split("\n").length;
    ok(`Exa — ~${lines} line(s) returned (${key ? "with API key" : "no key"})`);
    dim(`  → ${result.trim().split("\n")[0].slice(0, 100)}…`);
    return true;
  } catch (err) {
    fail(`Exa — ${err.message}`);
    return false;
  }
}

async function testParallel() {
  const key = process.env.PARALLEL_API_KEY;
  const headers = { "User-Agent": "pi-coding-agent" };
  if (key) headers.Authorization = `Bearer ${key}`;

  try {
    const result = await mcpCall("https://search.parallel.ai/mcp", "web_search", {
      objective: TEST_QUERY, search_queries: [TEST_QUERY], session_id: "test",
    }, headers);
    if (!result) { fail("Parallel — empty MCP response"); return false; }
    const lines = result.trim().split("\n").length;
    ok(`Parallel — ~${lines} line(s) returned (${key ? "with API key" : "no key"})`);
    dim(`  → ${result.trim().split("\n")[0].slice(0, 100)}…`);
    return true;
  } catch (err) {
    fail(`Parallel — ${err.message}`);
    return false;
  }
}

// ── Main ──

const ALL = {
  brave: testBrave,
  tavily: testTavily,
  google: testGoogle,
  searxng: testSearxng,
  exa: testExa,
  parallel: testParallel,
};

async function main() {
  const arg = process.argv[2]?.toLowerCase();
  const names = arg ? [arg] : Object.keys(ALL);

  console.log(`${C}═══════════════════════════════════════════════════════${X}`);
  console.log(`${C}  pi-websearch provider test${X}${arg ? ` — ${arg}` : ""}`);
  console.log(`${C}  Query: "${TEST_QUERY}"${X}`);
  console.log(`${C}═══════════════════════════════════════════════════════${X}\n`);

  let passed = 0, skipped = 0, failed = 0;

  for (const name of names) {
    const fn = ALL[name];
    if (!fn) {
      fail(`Unknown provider "${name}". Available: ${Object.keys(ALL).join(", ")}`);
      failed++;
      continue;
    }
    const result = await fn();
    if (result === true) passed++;
    else if (result === null) skipped++;
    else failed++;
    console.log("");
  }

  console.log(`${C}───────────────────────────────────────────────────────${X}`);
  console.log(`${G}Passed:${X}  ${passed}`);
  console.log(`${Y}Skipped:${X} ${skipped}`);
  console.log(`${R}Failed:${X}  ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
