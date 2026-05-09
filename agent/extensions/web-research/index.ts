import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const UA = "Mozilla/5.0 (compatible; pi-web-research/2.0; +https://pi.dev)";
const DEFAULT_MAX_BYTES = 8_000_000;
const DEFAULT_TEXT_LIMIT = 24_000;
const DEFAULT_FETCH_LIMIT = 3;
const MAX_FETCH_LIMIT = 8;

const searchParams = {
	type: "object",
	additionalProperties: false,
	required: ["query"],
	properties: {
		query: { type: "string", description: "Search query" },
		limit: { type: "number", description: "Maximum results, default 8, max 20" },
	},
} as const;

const fetchParams = {
	type: "object",
	additionalProperties: false,
	required: ["url"],
	properties: {
		url: { type: "string", description: "HTTP/HTTPS URL to fetch" },
		workdir: { type: "string", description: "Existing temp workdir to reuse" },
		maxBytes: { type: "number", description: "Maximum bytes to download, default 8000000" },
		includeMarkdown: { type: "boolean", description: "Include Markdown preview in tool result, default true" },
		textLimit: { type: "number", description: "Max Markdown chars in result, default 24000" },
		refresh: { type: "boolean", description: "Ignore cached file in workdir and refetch, default false" },
	},
} as const;

const researchParams = {
	type: "object",
	additionalProperties: false,
	required: ["query"],
	properties: {
		query: { type: "string", description: "Research question or search query" },
		searchLimit: { type: "number", description: "Search results to inspect, default 8, max 20" },
		fetchLimit: { type: "number", description: "Top search results to fetch, default 3, max 8" },
		workdir: { type: "string", description: "Existing temp workdir to reuse" },
		maxBytes: { type: "number", description: "Maximum bytes per fetch, default 8000000" },
		textLimit: { type: "number", description: "Max index Markdown chars in result, default 24000" },
	},
} as const;

type SearchResult = { title: string; url: string; snippet: string; source: string };
type FetchResult = {
	workdir: string;
	url: string;
	finalUrl: string;
	status: number;
	contentType: string;
	truncated: boolean;
	rawPath: string;
	markdownPath: string | null;
	textPath: string | null;
	title: string;
	description: string;
	byline: string;
	length: number;
	cached: boolean;
};

function clamp(n: unknown, fallback: number, min: number, max: number): number {
	const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
	return Math.max(min, Math.min(max, v));
}

function decodeHtml(input: string): string {
	return input
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function stripTags(input: string): string {
	return decodeHtml(input.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeMarkdown(input: string): string {
	return input
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

function ddgUrl(href: string): string {
	let cleaned = href.startsWith("//") ? `https:${href}` : href;
	try {
		const u = new URL(cleaned);
		const uddg = u.searchParams.get("uddg");
		if (uddg) cleaned = uddg;
	} catch {}
	return cleaned;
}

async function httpText(url: string, init: RequestInit, signal?: AbortSignal): Promise<{ text: string; response: Response }> {
	const response = await fetch(url, { ...init, signal, headers: { "user-agent": UA, ...(init.headers ?? {}) } });
	const text = await response.text();
	return { text, response };
}

async function braveSearch(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const key = process.env.BRAVE_API_KEY;
	if (!key) return [];
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(Math.min(limit, 20)));
	url.searchParams.set("text_decorations", "false");
	const { text, response } = await httpText(url.toString(), {
		headers: { accept: "application/json", "x-subscription-token": key },
	}, signal);
	if (!response.ok) throw new Error(`Brave search failed: HTTP ${response.status}`);
	const data = JSON.parse(text);
	return (data.web?.results ?? []).slice(0, limit).map((r: any) => ({
		title: stripTags(String(r.title ?? "")),
		url: String(r.url ?? ""),
		snippet: stripTags(String(r.description ?? "")),
		source: "brave",
	})).filter((r: SearchResult) => /^https?:\/\//i.test(r.url));
}

async function duckDuckGoSearch(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const body = new URLSearchParams({ q: query });
	const { text, response } = await httpText("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	}, signal);
	if (!response.ok) throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);

	const results: SearchResult[] = [];
	const linkRe = /<a(?=[^>]*class=["'][^"']*result__a[^"']*["'])(?=[^>]*href=["']([^"']+)["'])[^>]*>([\s\S]*?)<\/a>/gi;
	const matches = [...text.matchAll(linkRe)];
	for (let i = 0; i < matches.length && results.length < limit; i++) {
		const m = matches[i];
		const start = m.index ?? 0;
		const end = matches[i + 1]?.index ?? Math.min(text.length, start + 5000);
		const block = text.slice(start, end);
		const snippet = block.match(/<(?:a|div)(?=[^>]*class=["'][^"']*result__snippet[^"']*["'])[^>]*>([\s\S]*?)<\/(?:a|div)>/i)?.[1] ?? "";
		const url = ddgUrl((m[1] ?? "").replace(/&amp;/g, "&"));
		if (!/^https?:\/\//i.test(url)) continue;
		if (/^https?:\/\/duckduckgo\.com\/y\.js/i.test(url)) continue;
		results.push({ title: stripTags(m[2] ?? ""), url, snippet: stripTags(snippet), source: "duckduckgo" });
	}
	return results;
}

async function runSearch(query: string, limit: number, signal?: AbortSignal, onUpdate?: (u: any) => void): Promise<SearchResult[]> {
	let results = await braveSearch(query, limit, signal).catch(async (e) => {
		if (process.env.BRAVE_API_KEY) onUpdate?.({ content: [{ type: "text", text: `Brave failed, trying DuckDuckGo: ${e.message}` }] });
		return [] as SearchResult[];
	});
	if (results.length === 0) results = await duckDuckGoSearch(query, limit, signal);
	return results;
}

function urlHash(url: string): string {
	return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function safeStem(url: string): string {
	let base = "download";
	try {
		const u = new URL(url);
		base = path.basename(u.pathname.replace(/\/$/, "")) || u.hostname || base;
	} catch {}
	return base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "download";
}

function rawExt(contentType: string, url: string): string {
	const ext = path.extname(safeStem(url));
	if (ext) return ext;
	if (/html|xhtml/i.test(contentType)) return ".html";
	if (/json/i.test(contentType)) return ".json";
	if (/xml/i.test(contentType)) return ".xml";
	if (/markdown/i.test(contentType)) return ".md";
	if (/^text\//i.test(contentType)) return ".txt";
	return ".bin";
}

async function makeWorkdir(existing?: string): Promise<string> {
	if (existing) {
		await fs.mkdir(existing, { recursive: true });
		return existing;
	}
	return await fs.mkdtemp(path.join(tmpdir(), "pi-web-research-"));
}

function absUrl(base: string, maybeUrl: string): string {
	try { return new URL(maybeUrl, base).toString(); } catch { return maybeUrl; }
}

function htmlToResearchMarkdown(html: string, finalUrl: string, contentType: string): { title: string; markdown: string; description: string; byline: string; length: number } {
	const dom = new JSDOM(html, { url: finalUrl });
	const doc = dom.window.document;
	for (const el of Array.from(doc.querySelectorAll("script,style,noscript,svg,canvas,iframe,form"))) el.remove();
	for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
		const href = a.getAttribute("href");
		if (href) a.setAttribute("href", absUrl(finalUrl, href));
	}
	for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
		const src = img.getAttribute("src");
		if (src) img.setAttribute("src", absUrl(finalUrl, src));
	}

	const clone = doc.cloneNode(true) as Document;
	const article = new Readability(clone, { keepClasses: false }).parse();
	const title = stripTags(article?.title || doc.title || finalUrl);
	const description = stripTags(doc.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute("content") || article?.excerpt || "");
	const byline = stripTags(article?.byline || "");
	const htmlContent = article?.content || doc.body?.innerHTML || html;

	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
	turndown.remove(["script", "style", "noscript"]);
	const main = normalizeMarkdown(turndown.turndown(htmlContent));

	const links = Array.from(doc.querySelectorAll("a[href]"))
		.map((a) => ({ text: stripTags(a.textContent || ""), href: a.getAttribute("href") || "" }))
		.filter((l) => l.href && /^https?:\/\//i.test(l.href))
		.slice(0, 80);
	const seen = new Set<string>();
	const linkLines = links.filter((l) => {
		if (seen.has(l.href)) return false;
		seen.add(l.href);
		return true;
	}).map((l) => `- [${l.text || l.href}](${l.href})`).join("\n");

	const markdown = normalizeMarkdown(`---
url: ${finalUrl}
fetched_at: ${new Date().toISOString()}
title: ${JSON.stringify(title)}
content_type: ${contentType}
byline: ${JSON.stringify(byline)}
description: ${JSON.stringify(description)}
---

# ${title || finalUrl}

Source: ${finalUrl}

${description ? `> ${description}\n\n` : ""}## Main Content

${main || "(No readable article text extracted.)"}

${linkLines ? `## Links\n\n${linkLines}` : ""}
`) + "\n";
	return { title, markdown, description, byline, length: main.length };
}

function bytesToResearchMarkdown(body: Buffer, finalUrl: string, contentType: string): { markdown: string; title: string; description: string; byline: string; length: number } {
	const text = body.toString("utf8").trim();
	let content = text;
	let lang = "";
	if (/json/i.test(contentType)) {
		lang = "json";
		try { content = JSON.stringify(JSON.parse(text), null, 2); } catch {}
	} else if (/xml/i.test(contentType)) lang = "xml";
	else if (/csv/i.test(contentType)) lang = "csv";
	const fenced = /markdown/i.test(contentType) ? content : `\`\`\`${lang}\n${content}\n\`\`\``;
	const markdown = normalizeMarkdown(`---
url: ${finalUrl}
fetched_at: ${new Date().toISOString()}
title: ${JSON.stringify(finalUrl)}
content_type: ${contentType}
---

# ${finalUrl}

Source: ${finalUrl}

## Content

${fenced}
`) + "\n";
	return { markdown, title: finalUrl, description: "", byline: "", length: content.length };
}

async function fetchToMarkdown(params: any, signal?: AbortSignal, onUpdate?: (u: any) => void): Promise<FetchResult> {
	if (!/^https?:\/\//i.test(params.url)) throw new Error("web_fetch only supports http:// and https:// URLs");
	const maxBytes = clamp(params.maxBytes, DEFAULT_MAX_BYTES, 1_000, 50_000_000);
	const workdir = await makeWorkdir(params.workdir);
	const stem = `${safeStem(params.url)}.${urlHash(params.url)}`;
	const metaPath = path.join(workdir, `${stem}.meta.json`);
	if (!params.refresh) {
		try {
			const cached = JSON.parse(await fs.readFile(metaPath, "utf8"));
			if (cached?.markdownPath) return { ...cached, cached: true };
		} catch {}
	}

	onUpdate?.({ content: [{ type: "text", text: `Fetching ${params.url}` }] });
	const response = await fetch(params.url, { signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/json,application/xml,text/*,*/*;q=0.8" }, redirect: "follow" });
	const contentType = response.headers.get("content-type") ?? "application/octet-stream";
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Response has no body");
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		if (total + value.byteLength > maxBytes) {
			chunks.push(value.slice(0, Math.max(0, maxBytes - total)));
			truncated = true;
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const body = Buffer.concat(chunks);
	const finalUrl = response.url || params.url;
	const finalStem = `${safeStem(finalUrl)}.${urlHash(finalUrl)}`;
	const rawPath = path.join(workdir, `${finalStem}${rawExt(contentType, finalUrl)}`);
	await fs.writeFile(rawPath, body);

	let converted: { markdown: string; title: string; description: string; byline: string; length: number } | null = null;
	if (/html|xhtml/i.test(contentType)) converted = htmlToResearchMarkdown(body.toString("utf8"), finalUrl, contentType);
	else if (/^text\//i.test(contentType) || /json|xml|csv|markdown/i.test(contentType)) converted = bytesToResearchMarkdown(body, finalUrl, contentType);

	const markdownPath = converted ? path.join(workdir, `${finalStem}.md`) : null;
	if (markdownPath && converted) await fs.writeFile(markdownPath, converted.markdown, "utf8");

	const result: FetchResult = {
		workdir,
		url: params.url,
		finalUrl,
		status: response.status,
		contentType,
		truncated,
		rawPath,
		markdownPath,
		textPath: markdownPath,
		title: converted?.title ?? "",
		description: converted?.description ?? "",
		byline: converted?.byline ?? "",
		length: converted?.length ?? 0,
		cached: false,
	};
	await fs.writeFile(metaPath, JSON.stringify(result, null, 2), "utf8").catch(() => {});
	return result;
}

async function readPreview(file: string | null, limit: number): Promise<string> {
	if (!file) return "";
	const text = await fs.readFile(file, "utf8");
	return `${text.slice(0, limit)}${text.length > limit ? "\n...[truncated in tool result; read markdownPath for full markdown]" : ""}`;
}

function sourceId(i: number): string { return `S${i + 1}`; }

export default function webResearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web for current/public information. Uses Brave Search when BRAVE_API_KEY is set, otherwise DuckDuckGo HTML.",
		promptSnippet: "Search the web for current facts, unfamiliar terms, docs, or external information",
		promptGuidelines: [
			"Use web_search when the user asks for current information, unfamiliar online facts, recent docs, or something outside model knowledge.",
			"Prefer official/primary sources from web_search results before fetching pages.",
		],
		parameters: searchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const limit = clamp(params.limit, 8, 1, 20);
			onUpdate?.({ content: [{ type: "text", text: `Searching web: ${params.query}` }] });
			const results = await runSearch(params.query, limit, signal, onUpdate);
			const text = results.map((r, i) => `[${sourceId(i)}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join("\n\n") || "No results.";
			return { content: [{ type: "text", text }], details: { query: params.query, limit, results } };
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "Fetch/download a URL and convert readable web content into a Markdown research file in a temporary directory.",
		promptSnippet: "Fetch a URL and convert it to a clean Markdown research file",
		promptGuidelines: [
			"Use web_fetch after web_search to inspect promising sources; cite fetched source URLs in final answers.",
			"Use web_fetch markdownPath as the canonical web context; read markdownPath when full context is needed.",
		],
		parameters: fetchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const textLimit = clamp(params.textLimit, DEFAULT_TEXT_LIMIT, 1_000, 100_000);
			const includeMarkdown = params.includeMarkdown !== false;
			const result = await fetchToMarkdown(params, signal, onUpdate);
			const preview = includeMarkdown ? await readPreview(result.markdownPath, textLimit) : "";
			const text = [JSON.stringify(result, null, 2), preview ? `\nMarkdown preview:\n${preview}` : ""].filter(Boolean).join("\n");
			return { content: [{ type: "text", text }], details: result };
		},
	});

	pi.registerTool({
		name: "web_research",
		label: "Web Research",
		description: "Navigate the web for context: search, fetch top sources, convert them to Markdown, and create an index.md research bundle that helps clarify/understand the user's task.",
		promptSnippet: "Navigate web sources and build a Markdown research bundle for agent context",
		promptGuidelines: [
			"Use web_research when user input is vague, insufficient, current, or outside local/model context and internet context can clarify the task.",
			"Use web_research to build context before answering; cite source URLs from the returned index when web data affects the answer.",
		],
		parameters: researchParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const searchLimit = clamp(params.searchLimit, 8, 1, 20);
			const fetchLimit = clamp(params.fetchLimit, DEFAULT_FETCH_LIMIT, 1, MAX_FETCH_LIMIT);
			const textLimit = clamp(params.textLimit, DEFAULT_TEXT_LIMIT, 1_000, 100_000);
			const workdir = await makeWorkdir(params.workdir);
			onUpdate?.({ content: [{ type: "text", text: `Research search: ${params.query}` }] });
			const results = await runSearch(params.query, searchLimit, signal, onUpdate);
			const fetched: Array<{ sourceId: string; search: SearchResult; fetch?: FetchResult; error?: string }> = [];
			for (const [i, result] of results.slice(0, fetchLimit).entries()) {
				onUpdate?.({ content: [{ type: "text", text: `Fetching [${sourceId(i)}] ${result.url}` }] });
				try {
					const fetch = await fetchToMarkdown({ url: result.url, workdir, maxBytes: params.maxBytes }, signal, onUpdate);
					fetched.push({ sourceId: sourceId(i), search: result, fetch });
				} catch (e: any) {
					fetched.push({ sourceId: sourceId(i), search: result, error: e?.message ?? String(e) });
				}
			}

			const indexPath = path.join(workdir, "index.md");
			const lines = [
				"---",
				`query: ${JSON.stringify(params.query)}`,
				`created_at: ${new Date().toISOString()}`,
				`search_limit: ${searchLimit}`,
				`fetch_limit: ${fetchLimit}`,
				"---",
				"",
				`# Web Research: ${params.query}`,
				"",
				"## Sources",
				"",
				...fetched.map((f) => f.fetch
					? `- [${f.sourceId}] [${f.fetch.title || f.search.title}](${f.fetch.finalUrl}) — Markdown: \`${f.fetch.markdownPath}\`\n  - Snippet: ${f.search.snippet || f.fetch.description}`
					: `- [${f.sourceId}] [${f.search.title}](${f.search.url}) — FETCH FAILED: ${f.error}`),
				"",
				"## Unfetched Search Results",
				"",
				...results.slice(fetchLimit).map((r, i) => `- [${sourceId(i + fetchLimit)}] [${r.title}](${r.url}) — ${r.snippet}`),
				"",
				"## How To Use",
				"",
				"Read the Markdown files above for full source context. Cite URLs, not local paths, in final answers.",
				"",
			].join("\n");
			await fs.writeFile(indexPath, lines, "utf8");
			const preview = `${lines.slice(0, textLimit)}${lines.length > textLimit ? "\n...[truncated in tool result; read indexPath for full bundle]" : ""}`;
			return {
				content: [{ type: "text", text: `${JSON.stringify({ workdir, indexPath, query: params.query, searched: results.length, fetched: fetched.length }, null, 2)}\n\n${preview}` }],
				details: { workdir, indexPath, query: params.query, results, fetched },
			};
		},
	});

	pi.registerCommand("web-research-status", {
		description: "Show web research extension status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`web-research tools loaded. Brave API: ${process.env.BRAVE_API_KEY ? "enabled" : "not set; DuckDuckGo fallback"}`, "info");
		},
	});
}
