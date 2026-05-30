/**
 * Web Search + Web Fetch Extension for Pi
 *
 * Mirrors opencode's approach:
 * - websearch: Exa/Parallel via MCP JSON-RPC (same provider selection logic)
 * - webfetch: direct HTTP fetch + HTML→markdown conversion (same as opencode)
 *
 * API keys (search only):
 *   EXA_API_KEY         - Exa search (optional, works without it)
 *   PARALLEL_API_KEY    - Parallel search (optional, works without it)
 *
 * Override:
 *   PI_WEBSEARCH_PROVIDER=exa|parallel
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import TurndownService from "turndown";
import { Parser, parseDocument } from "htmlparser2";
import { isTag, type AnyNode, type Element, type Document as DomDocument } from "domhandler";
import { removeElement, textContent, getElementsByTagName, getChildren, getAttributeValue } from "domutils";
import { render } from "dom-serializer";
import { extractText, getMeta, getDocumentProxy } from "unpdf";

// ---------------------------------------------------------------------------
// Deterministic provider selection (same logic as opencode)
// ---------------------------------------------------------------------------

function checksum(input: string): string | undefined {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function selectSearchProvider(sessionId: string): "exa" | "parallel" {
  const override = process.env.PI_WEBSEARCH_PROVIDER;
  if (override === "exa" || override === "parallel") return override;

  // Deterministic hash split (same as opencode) — both providers
  // work on free tiers without API keys via MCP.
  const hash = Number.parseInt(checksum(sessionId) ?? "0", 36);
  return hash % 2 === 0 ? "exa" : "parallel";
}

// ---------------------------------------------------------------------------
// MCP call (mirrors opencode's mcp-websearch.ts)
// ---------------------------------------------------------------------------

const MCP_TIMEOUT_MS = 25_000;

function parseMcpResponse(body: string): string | undefined {
  const tryParse = (payload: string): string | undefined => {
    const trimmed = payload.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const data = JSON.parse(trimmed);
      const content: { type: string; text: string }[] = data?.result?.content;
      return content?.find((item) => item.text)?.text;
    } catch {
      return undefined;
    }
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

async function mcpCall(
  url: string,
  tool: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${tool} returned HTTP ${response.status}`);
    }

    return parseMcpResponse(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Search providers
// ---------------------------------------------------------------------------

function exaUrl(): string {
  const key = process.env.EXA_API_KEY;
  return key
    ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(key)}`
    : "https://mcp.exa.ai/mcp";
}

async function searchExa(
  query: string,
  numResults?: number,
): Promise<string | undefined> {
  return mcpCall(exaUrl(), "web_search_exa", {
    query,
    type: "auto",
    numResults: numResults ?? 8,
    livecrawl: "fallback",
  });
}

async function searchParallel(
  query: string,
  sessionId?: string,
): Promise<string | undefined> {
  const headers: Record<string, string> = {
    "User-Agent": "pi-coding-agent",
  };
  const key = process.env.PARALLEL_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;

  return mcpCall("https://search.parallel.ai/mcp", "web_search", {
    objective: query,
    search_queries: [query],
    session_id: sessionId,
  }, headers);
}

// ---------------------------------------------------------------------------
// Web fetch (same approach as opencode's webfetch.ts)
// ---------------------------------------------------------------------------

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024 // 10MB
const DEFAULT_FETCH_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_FETCH_TIMEOUT = 120 * 1000 // 2 minutes

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
}

function isPdfMime(mime: string): boolean {
  return mime === "application/pdf"
}

async function streamResponseToBuffer(
  response: Response,
  onUpdate?: (update: { content: Array<{ type: "text"; text: string }> }) => void,
  label = "Fetching",
): Promise<Buffer> {
  if (!response.body) {
    const ab = await response.arrayBuffer()
    return Buffer.from(ab)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  let lastReportedBytes = 0
  const contentLength = response.headers.get("content-length")
  const totalBytes = contentLength ? parseInt(contentLength) : undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    chunks.push(value)
    receivedBytes += value.length

    if (receivedBytes > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 10MB limit)")
    }

    if (receivedBytes - lastReportedBytes > 20_000) {
      let msg: string
      if (totalBytes && totalBytes > 0) {
        const pct = Math.round((receivedBytes / totalBytes) * 100)
        msg = `${label}... ${Math.round(receivedBytes / 1024)} KB / ${Math.round(totalBytes / 1024)} KB (${pct}%)`
      } else {
        msg = `${label}... ${Math.round(receivedBytes / 1024)} KB received`
      }
      onUpdate?.({ content: [{ type: "text", text: msg }] })
      lastReportedBytes = receivedBytes
    }
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)))
}

function extractTextFromHTML(html: string): string {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}

// ---------------------------------------------------------------------------
// Auto-extract main content from fetched HTML (Issue #21)
// ---------------------------------------------------------------------------

const NOISE_TAGS = new Set([
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
])

const NOISE_PATTERNS = [
  /cookie|consent|gdpr|banner/i,
  /ad-|ads-|advertisement|promo/i,
  /sidebar|widget|newsletter|subscribe/i,
  /social|share-|follow-us/i,
  /comment|disqus/i,
  /popup|modal|overlay/i,
]

function isNoiseElement(node: AnyNode): boolean {
  if (!isTag(node)) return false
  const tag = node.name.toLowerCase()
  if (NOISE_TAGS.has(tag)) return true
  const id = getAttributeValue(node, "id") || ""
  const cls = getAttributeValue(node, "class") || ""
  const combined = `${id} ${cls}`
  return NOISE_PATTERNS.some((p) => p.test(combined))
}

function removeNoiseNodes(node: AnyNode): void {
  if (!isTag(node)) return
  const children = getChildren(node).slice()
  for (const child of children) {
    if (isNoiseElement(child)) {
      removeElement(child)
    } else {
      removeNoiseNodes(child)
    }
  }
}

function extractMainContent(doc: DomDocument): AnyNode[] {
  const articles = getElementsByTagName("article", doc)
  const mains = getElementsByTagName("main", doc)
  const semantic: AnyNode[] = []
  if (articles.length > 0) semantic.push(...articles)
  if (mains.length > 0) semantic.push(...mains)
  if (semantic.length > 0) {
    return semantic
  }

  // Fallback heuristic: recursively find the block-level element with
  // the highest text-to-tag density inside <body>.
  const body = getElementsByTagName("body", doc)[0]
  if (!body) return [doc]

  let best: Element | null = null
  let bestScore = 0

  function walk(node: AnyNode): void {
    if (!isTag(node)) return
    if (isNoiseElement(node)) return
    const tag = node.name.toLowerCase()
    if (tag === "div" || tag === "section") {
      const txt = textContent(node).length
      // Simple density: text chars / (1 + number of child tags).  We approximate
      // by counting how many tag children exist.  A higher score means more text
      // per markup, i.e. likely the main article container.
      const childTags = getChildren(node).filter((c) => isTag(c)).length
      const density = txt / (1 + childTags)
      // Prefer larger containers, but boost by density so a giant wrapper
      // full of wrappers doesn't win over the actual content div.
      const score = txt + density * 10
      if (score > bestScore) {
        bestScore = score
        best = node
      }
    }
    for (const child of getChildren(node)) {
      walk(child)
    }
  }

  walk(body)

  return best ? [best] : [doc]
}

function cleanAndExtractHTML(html: string): string {
  const doc = parseDocument(html, { lowerCaseAttributeNames: true })
  // Remove noise from the root down
  for (const child of getChildren(doc).slice()) {
    if (isNoiseElement(child)) {
      removeElement(child)
    } else {
      removeNoiseNodes(child)
    }
  }
  const mainNodes = extractMainContent(doc)
  if (mainNodes.length === 1 && mainNodes[0] === doc) {
    return render(doc)
  }
  const cleaned = render(mainNodes)
  // Never return empty; fallback to original if extraction wiped everything
  if (!cleaned.trim()) return html
  return cleaned
}

// ---------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------

interface PdfExtractionResult {
  text: string
  pages: number
  metadata?: PageMetadata
}

async function extractTextFromPDF(buffer: Buffer): Promise<PdfExtractionResult> {
  const uint8 = new Uint8Array(buffer)
  try {
    const doc = await getDocumentProxy(uint8)
    const meta = await getMeta(doc)
    const result = await extractText(doc)

    // Build page-marked text
    const parts: string[] = []
    for (let i = 0; i < result.text.length; i++) {
      const pageText = result.text[i]?.trim()
      if (pageText) {
        parts.push(`--- Page ${i + 1} ---`)
        parts.push(pageText)
        parts.push("")
      }
    }

    const metadata: PageMetadata = {
      title: meta.info?.Title || undefined,
      author: meta.info?.Author || undefined,
    }

    return { text: parts.join("\n").trim(), pages: result.totalPages, metadata }
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    if (msg.toLowerCase().includes("password") || err?.name === "PasswordException") {
      throw new Error("This PDF is password-protected and cannot be read.")
    }
    throw new Error(`Failed to extract text from PDF: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// Structured metadata extraction (Issue #15)
// ---------------------------------------------------------------------------

interface PageMetadata {
  title?: string
  description?: string
  author?: string
  publishedDate?: string
  canonicalUrl?: string
  image?: string
  siteName?: string
  type?: string
}

function extractMetadata(html: string): PageMetadata {
  const og: Record<string, string> = {}
  const meta: Record<string, string> = {}
  const jsonLdScripts: string[] = []
  let title = ""
  let canonical = ""

  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === "meta") {
        const prop = attributes.property
        const nameAttr = attributes.name
        const content = attributes.content
        if (prop && content) {
          og[prop] = content
        } else if (nameAttr && content) {
          meta[nameAttr.toLowerCase()] = content
        }
      } else if (name === "title") {
        // will collect text in ontext
      } else if (name === "link" && attributes.rel === "canonical" && attributes.href) {
        canonical = attributes.href
      } else if (name === "script" && attributes.type === "application/ld+json") {
        // will collect text in ontext
      }
    },
    ontext(text) {
      const currentTag = (parser as unknown as { _tagname?: string })._tagname
      if (currentTag === "title") {
        title = text
      }
      // htmlparser2 doesn't expose current tag easily in ontext,
      // so we handle JSON-LD by finding script blocks in raw html instead.
    },
  })

  // Parse meta, title, canonical, og tags
  parser.write(html)
  parser.end()

  // Extract title via regex fallback since htmlparser2 ontext is tricky inline
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch) {
    title = titleMatch[1].replace(/\s+/g, " ").trim()
  }

  // Extract JSON-LD blocks
  const ldJsonRe = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = ldJsonRe.exec(html)) !== null) {
    jsonLdScripts.push(m[1].trim())
  }

  // Parse JSON-LD candidates
  let jsonLd: Record<string, unknown> | undefined
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script) as Record<string, unknown> | Record<string, unknown>[]
      const candidates = Array.isArray(data) ? data : [data]
      // Prefer Article, NewsArticle, BlogPosting, WebPage schemas
      const preferred = candidates.find(
        (c) =>
          typeof c === "object" &&
          c !== null &&
          (["Article", "NewsArticle", "BlogPosting", "WebPage", "Product", "Organization"].includes(
            String(c["@type"]),
          )),
      )
      jsonLd = preferred ?? candidates[0]
      if (jsonLd) break
    } catch {
      // ignore malformed JSON-LD
    }
  }

  // Helper to safely get nested string fields from JSON-LD
  function ldString(path: string[]): string | undefined {
    if (!jsonLd) return undefined
    let current: unknown = jsonLd
    for (const key of path) {
      if (current && typeof current === "object" && key in current) {
        current = (current as Record<string, unknown>)[key]
      } else {
        return undefined
      }
    }
    return typeof current === "string" ? current : undefined
  }

  function ldAuthor(): string | undefined {
    if (!jsonLd) return undefined
    const author = jsonLd.author
    if (typeof author === "string") return author
    if (author && typeof author === "object") {
      const name = (author as Record<string, unknown>).name
      if (typeof name === "string") return name
    }
    const creator = jsonLd.creator
    if (typeof creator === "string") return creator
    if (creator && typeof creator === "object") {
      const name = (creator as Record<string, unknown>).name
      if (typeof name === "string") return name
    }
    return undefined
  }

  function ldImage(): string | undefined {
    if (!jsonLd) return undefined
    const image = jsonLd.image
    if (typeof image === "string") return image
    if (image && typeof image === "object") {
      const url = (image as Record<string, unknown>).url
      if (typeof url === "string") return url
    }
    return undefined
  }

  // Merge with priority: OpenGraph > JSON-LD > HTML meta
  return {
    title: og["og:title"] || jsonLd?.headline || title || meta.description || undefined,
    description: og["og:description"] || jsonLd?.description || meta.description || undefined,
    author: og["og:article:author"] || ldAuthor() || meta.author || undefined,
    publishedDate: og["og:article:published_time"] || ldString(["datePublished"]) || meta.date || undefined,
    canonicalUrl: og["og:url"] || canonical || undefined,
    image: og["og:image"] || ldImage() || undefined,
    siteName: og["og:site_name"] || undefined,
    type: og["og:type"] || (jsonLd ? String(jsonLd["@type"]).toLowerCase() : undefined),
  }
}

async function fetchUrl(
  url: string,
  format: "text" | "markdown" | "html",
  timeoutSec?: number,
  signal?: AbortSignal,
  onUpdate?: (update: { content: Array<{ type: "text"; text: string }> }) => void,
): Promise<{ content: string; contentType: string; isImage: boolean; imageMime?: string; imageBase64?: string; metadata?: PageMetadata }> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("URL must start with http:// or https://")
  }

  const timeout = Math.min((timeoutSec ?? DEFAULT_FETCH_TIMEOUT / 1000) * 1000, MAX_FETCH_TIMEOUT)

  // Build Accept header based on requested format (same as opencode)
  let acceptHeader = "*/*"
  switch (format) {
    case "markdown":
      acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
      break
    case "text":
      acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
      break
    case "html":
      acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
      break
  }

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    Accept: acceptHeader,
    "Accept-Language": "en-US,en;q=0.9",
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  // Also respect the outer signal
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true })
  }

  let response: Response
  try {
    response = await fetch(url, { headers, signal: controller.signal })

    // Retry with honest UA if blocked by Cloudflare bot detection (same as opencode)
    if (
      response.status === 403 &&
      response.headers.get("cf-mitigated") === "challenge"
    ) {
      response = await fetch(url, {
        headers: { ...headers, "User-Agent": "opencode" },
        signal: controller.signal,
      })
    }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }

  // Check content length
  const contentLength = response.headers.get("content-length")
  if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
    throw new Error("Response too large (exceeds 10MB limit)")
  }

  const contentType = response.headers.get("content-type") || ""
  const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""

  // Also check URL extension as fallback for PDF detection
  const urlPath = new URL(url).pathname.toLowerCase()
  const isPdf = isPdfMime(mime) || urlPath.endsWith(".pdf")

  if (isImageMime(mime)) {
    const buffer = await streamResponseToBuffer(response, onUpdate, "Downloading image")
    if (buffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 10MB limit)")
    }
    const base64Content = buffer.toString("base64")
    return {
      content: "Image fetched successfully",
      contentType,
      isImage: true,
      imageMime: mime,
      imageBase64: base64Content,
    }
  }

  if (isPdf) {
    const buffer = await streamResponseToBuffer(response, onUpdate, "Downloading PDF")
    if (buffer.byteLength > MAX_RESPONSE_SIZE) {
      throw new Error("Response too large (exceeds 10MB limit)")
    }
    onUpdate?.({ content: [{ type: "text", text: `Extracting PDF text (${Math.round(buffer.byteLength / 1024)} KB)...` }] })
    const pdfResult = await extractTextFromPDF(buffer)

    let content = pdfResult.text
    if (format === "html") {
      content = `<pre>${content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`
    }

    return {
      content,
      contentType,
      isImage: false,
      metadata: pdfResult.metadata,
    }
  }

  let text: string

  if (response.body) {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let chunks = ""
    let receivedBytes = 0
    let lastReportedBytes = 0
    const totalBytes = contentLength ? parseInt(contentLength) : undefined

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      receivedBytes += value.length
      if (receivedBytes > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 10MB limit)")
      }

      chunks += decoder.decode(value, { stream: true })

      if (receivedBytes - lastReportedBytes > 20_000) {
        let msg: string
        if (totalBytes && totalBytes > 0) {
          const pct = Math.round((receivedBytes / totalBytes) * 100)
          msg = `Fetching... ${Math.round(receivedBytes / 1024)} KB / ${Math.round(totalBytes / 1024)} KB (${pct}%)`
        } else {
          msg = `Fetching... ${Math.round(receivedBytes / 1024)} KB received`
        }
        onUpdate?.({ content: [{ type: "text", text: msg }] })
        lastReportedBytes = receivedBytes
      }
    }

    chunks += decoder.decode()
    text = chunks
  } else {
    text = await response.text()
  }

  // Handle content based on requested format and actual content type (same as opencode)
  const metadata = extractMetadata(text)
  switch (format) {
    case "markdown":
      if (contentType.includes("text/html")) {
        const cleaned = cleanAndExtractHTML(text)
        return { content: convertHTMLToMarkdown(cleaned), contentType, isImage: false, metadata }
      }
      return { content: text, contentType, isImage: false, metadata }

    case "text":
      if (contentType.includes("text/html")) {
        const cleaned = cleanAndExtractHTML(text)
        return { content: extractTextFromHTML(cleaned), contentType, isImage: false, metadata }
      }
      return { content: text, contentType, isImage: false, metadata }

    case "html":
      return { content: text, contentType, isImage: false, metadata }

    default:
      return { content: text, contentType, isImage: false, metadata }
  }
}

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

function truncateOutput(output: string): string {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;

  if (truncation.truncated) {
    const tmpFile = join(mkdtempSync(join(tmpdir(), "pi-search-")), "output.md");
    writeFileSync(tmpFile, output, "utf8");

    result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tmpFile}]`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const WebSearchParams = Type.Object({
  query: Type.String({ description: "Web search query" }),
  numResults: Type.Optional(
    Type.Number({ description: "Number of search results to return (default: 8)" }),
  ),
});

const WebFetchParams = Type.Object({
  url: Type.String({ description: "URL to fetch content from" }),
  format: Type.Optional(
    Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
      description: 'Format to return content in: "text", "markdown", or "html". Defaults to "markdown".',
    }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Optional timeout in seconds (max 120)" }),
  ),
});

export default function webSearchExtension(pi: ExtensionAPI) {
  const year = new Date().getFullYear();

  // --- websearch ---

  pi.registerTool({
    name: "websearch",
    label: "Web Search",
    description: [
      "Search the web for up-to-date information.",
      "Returns content from the most relevant websites for the given query.",
      "Use this tool when you need information beyond your knowledge cutoff, current events, or recent data.",
      "",
      `The current year is ${year}. You MUST use this year when searching for recent information or current events.`,
      `Example: If the current year is ${year} and the user asks for "latest AI news", search for "AI news ${year}"`,
    ].join("\n"),
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use websearch when you need current information beyond your knowledge cutoff.",
      "Always include the current year in search queries about recent events.",
    ],
    parameters: WebSearchParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionFile() ?? "default";
      const provider = selectSearchProvider(sessionId);

      onUpdate?.({
        content: [
          { type: "text", text: `Searching via ${provider}: "${params.query}"...` },
        ],
      });

      const result =
        provider === "exa"
          ? await searchExa(params.query, params.numResults)
          : await searchParallel(params.query, sessionId);

      const output = result ?? "No search results found. Please try a different query.";

      return {
        content: [{ type: "text", text: truncateOutput(output) }],
        details: { provider, query: params.query },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("websearch "));
      text += theme.fg("accent", `"${args.query}"`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";

      if (isPartial) {
        const msg = text || "\u23f3 Searching...";
        return new Text(theme.fg("warning", msg), 0, 0);
      }

      const details = result.details as { provider: string; query: string } | undefined;
      const lineCount = text.split("\n").length;

      let out = theme.fg("success", "\u2713");
      out += theme.fg("dim", ` ${lineCount} lines via ${details?.provider ?? "unknown"}`);

      if (expanded) {
        const lines = text.split("\n").slice(0, 20);
        for (const line of lines) {
          out += `\n${theme.fg("dim", line)}`;
        }
        if (lineCount > 20) {
          out += `\n${theme.fg("muted", `... ${lineCount - 20} more lines`)}`;
        }
      } else {
        out += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
      }

      return new Text(out, 0, 0);
    },
  });

  // --- webfetch (same approach as opencode) ---

  pi.registerTool({
    name: "webfetch",
    label: "Web Fetch",
    description: [
      "Fetch and extract the text content of a web page or PDF URL.",
      "Returns the page content as markdown text.",
      "PDFs are automatically detected and their text is extracted with page markers.",
      "Use this tool to read specific web pages when you have a URL.",
    ].join("\n"),
    promptSnippet: "Fetch and extract text content from a URL",
    promptGuidelines: [
      "Use webfetch when you have a specific URL and need to read its content.",
      "For general web searching, use websearch instead.",
    ],
    parameters: WebFetchParams,

    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const format = (params.format as "text" | "markdown" | "html" | undefined) ?? "markdown"

      onUpdate?.({
        content: [
          { type: "text", text: `Fetching ${params.url} (${format})...` },
        ],
      });

      const result = await fetchUrl(params.url, format, params.timeout, signal ?? undefined, onUpdate);

      if (result.isImage && result.imageMime && result.imageBase64) {
        return {
          content: [
            {
              type: "text",
              text: `Image fetched: ${params.url} (${result.contentType})`,
            },
          ],
          details: { url: params.url, format, contentType: result.contentType, isImage: true },
          attachments: [
            {
              type: "file" as const,
              mime: result.imageMime,
              url: `data:${result.imageMime};base64,${result.imageBase64}`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: truncateOutput(result.content) }],
        details: { url: params.url, format, contentType: result.contentType, metadata: result.metadata },
      };
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("webfetch "));
      const url = args.url.length > 80 ? `${args.url.slice(0, 77)}...` : args.url;
      text += theme.fg("accent", url);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";

      if (isPartial) {
        const msg = text || "\u23f3 Fetching...";
        return new Text(theme.fg("warning", msg), 0, 0);
      }

      const details = result.details as { url: string; format: string; contentType: string; isImage?: boolean; metadata?: PageMetadata } | undefined;

      // Image result
      if (details?.isImage) {
        return new Text(theme.fg("success", "\u2713 Image fetched"), 0, 0);
      }

      const byteSize = Buffer.byteLength(text, "utf8");
      const lineCount = text.split("\n").length;

      let out = theme.fg("success", "\u2713");
      out += theme.fg("dim", ` ${formatSize(byteSize)} ${details?.format ?? "markdown"} (${lineCount} lines)`);

      // Show metadata summary if available
      const md = details?.metadata
      if (md && (md.title || md.author || md.publishedDate)) {
        const parts: string[] = []
        if (md.title) parts.push(md.title)
        if (md.author) parts.push(`by ${md.author}`)
        if (md.publishedDate) parts.push(md.publishedDate)
        out += `\n${theme.fg("accent", parts.join(" | "))}`
      }

      if (expanded) {
        const lines = text.split("\n").slice(0, 20);
        for (const line of lines) {
          out += `\n${theme.fg("dim", line)}`;
        }
        if (lineCount > 20) {
          out += `\n${theme.fg("muted", `... ${lineCount - 20} more lines`)}`;
        }
      } else {
        out += theme.fg("dim", ` (${keyHint("app.tools.expand", "expand")})`);
      }

      return new Text(out, 0, 0);
    },
  });
}
