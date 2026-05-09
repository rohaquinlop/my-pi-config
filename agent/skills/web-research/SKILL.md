---
name: web-research
description: Search the web, fetch pages/files into a temporary directory, transform fetched web content into Markdown research files, and use downloaded content as context. Use when the user asks for current information, unfamiliar terms, online documentation, facts outside model knowledge, or asks to navigate/download internet content for analysis.
---

# Web Research

Main goal: help the agent navigate the web, search for useful external content, fetch it, convert it into Markdown research context, and use that context to understand/clarify the user's task.

Use this skill when local/project knowledge is insufficient, the user asks for current/external internet information, or the user's input is vague and web context may clarify meaning/requirements.

Prefer the Pi extension tools `web_search`, `web_fetch`, and `web_research` when available. Use bundled scripts only as fallback.

## Rules

- Prefer official/primary sources, docs, standards, repos, papers, and vendor pages.
- Keep downloads temporary under `/tmp/pi-web-research-*` unless user asks to save elsewhere.
- Do not download huge files unless necessary. Default scripts cap response bytes.
- Do not send credentials/tokens to arbitrary sites.
- Use web research to improve agent context, not to browse endlessly.
- Cite URLs in the final answer when web data affects the answer.
- If search fails or the intent remains unclear, ask user for a URL or search query refinement.

## Tools

Search:

```text
web_search({ "query": "query terms", "limit": 8 })
```

Fetch/download/convert one URL to Markdown:

```text
web_fetch({ "url": "https://example.com/page", "maxBytes": 5000000 })
web_fetch({ "url": "https://example.com/file", "workdir": "/tmp/pi-web-research-abc" })
```

End-to-end research bundle:

```text
web_research({ "query": "what user likely means", "searchLimit": 8, "fetchLimit": 3 })
```

`BRAVE_API_KEY` enables Brave Search API. Without it, `web_search` / `web_research` fall back to DuckDuckGo HTML search.

## Script Fallback

From this skill directory, if tools are unavailable:

```bash
python3 scripts/search.py "query terms" --limit 8
python3 scripts/fetch.py "https://example.com/page"
```

Fetch output contains:

- `workdir`: temp directory used
- `url`, `final_url`, `status`, `content_type`
- `raw_path`: downloaded body
- `markdownPath`: Markdown research file when possible (`textPath` may be present as backward-compatible alias)
- `title`: HTML title when present

## Workflow

1. If user input is vague/insufficient or outside current/local context, use `web_research` first to build context.
2. For targeted lookup, use `web_search`, pick 2-5 promising URLs, then `web_fetch` each.
3. Use returned `indexPath` / `markdownPath` as canonical research context.
4. Read Markdown files with the `read` tool when full source context is needed.
5. Continue following links only when needed.
6. Final answer: concise, cite the source URLs used, not temp file paths.
