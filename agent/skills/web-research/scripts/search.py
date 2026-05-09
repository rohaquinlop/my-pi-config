#!/usr/bin/env python3
"""Small web search helper for pi web-research skill.

Uses Brave Search API when BRAVE_API_KEY is set; otherwise DuckDuckGo HTML.
Outputs JSON lines.
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (compatible; pi-web-research/1.0; +https://pi.dev)"


def ssl_context(insecure: bool = False):
    if insecure or os.environ.get("PI_WEB_RESEARCH_INSECURE") == "1":
        return ssl._create_unverified_context()  # explicit opt-in via flag/env
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def request(url: str, headers: dict[str, str] | None = None, timeout: int = 20, insecure: bool = False) -> bytes:
    h = {"User-Agent": UA, **(headers or {})}
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout, context=ssl_context(insecure)) as r:  # nosec - user-driven research tool
        return r.read()


def brave(query: str, limit: int, insecure: bool = False) -> list[dict[str, str]]:
    key = os.environ.get("BRAVE_API_KEY")
    if not key:
        return []
    params = urllib.parse.urlencode({"q": query, "count": min(limit, 20), "text_decorations": "false"})
    data = request(
        "https://api.search.brave.com/res/v1/web/search?" + params,
        {"Accept": "application/json", "X-Subscription-Token": key},
        insecure=insecure,
    )
    js = json.loads(data.decode("utf-8", "replace"))
    out: list[dict[str, str]] = []
    for item in js.get("web", {}).get("results", [])[:limit]:
        out.append({
            "title": html.unescape(strip_tags(item.get("title", ""))).strip(),
            "url": item.get("url", ""),
            "snippet": html.unescape(strip_tags(item.get("description", ""))).strip(),
            "source": "brave",
        })
    return out


def strip_tags(s: str) -> str:
    return re.sub(r"<[^>]+>", "", s or "")


class DDGParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict[str, str]] = []
        self.in_title = False
        self.in_snippet = False
        self.current: dict[str, str] | None = None
        self.buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        cls = a.get("class", "") or ""
        if tag == "a" and "result__a" in cls:
            href = a.get("href", "") or ""
            self.current = {"title": "", "url": clean_ddg_url(href), "snippet": "", "source": "duckduckgo"}
            self.in_title = True
            self.buf = []
        elif self.current and tag in {"a", "div"} and "result__snippet" in cls:
            self.in_snippet = True
            self.buf = []

    def handle_data(self, data: str) -> None:
        if self.in_title or self.in_snippet:
            self.buf.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self.in_title and tag == "a" and self.current:
            self.current["title"] = html.unescape(" ".join(self.buf)).strip()
            if self.current.get("url"):
                self.results.append(self.current)
            self.in_title = False
            self.buf = []
        elif self.in_snippet and tag in {"a", "div"} and self.results:
            self.results[-1]["snippet"] = html.unescape(" ".join(self.buf)).strip()
            self.in_snippet = False
            self.buf = []


def clean_ddg_url(href: str) -> str:
    if href.startswith("//"):
        href = "https:" + href
    try:
        parsed = urllib.parse.urlparse(href)
        qs = urllib.parse.parse_qs(parsed.query)
        if "uddg" in qs:
            return qs["uddg"][0]
    except Exception:
        pass
    return href


def duckduckgo(query: str, limit: int, insecure: bool = False) -> list[dict[str, str]]:
    params = urllib.parse.urlencode({"q": query})
    body = urllib.parse.urlencode({"q": query}).encode()
    # POST endpoint tends to be stable for non-JS HTML results.
    req = urllib.request.Request(
        "https://html.duckduckgo.com/html/",
        data=body,
        headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=25, context=ssl_context(insecure)) as r:  # nosec - user-driven research tool
        page = r.read().decode("utf-8", "replace")
    p = DDGParser()
    p.feed(page)
    return p.results[:limit]


def main() -> int:
    ap = argparse.ArgumentParser(description="Search web and emit JSON lines")
    ap.add_argument("query")
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--insecure", action="store_true", help="Disable TLS certificate verification")
    args = ap.parse_args()

    try:
        results = brave(args.query, args.limit, args.insecure) or duckduckgo(args.query, args.limit, args.insecure)
    except Exception as e:
        print(json.dumps({"error": str(e), "hint": "Set BRAVE_API_KEY or try a different query"}), file=sys.stderr)
        return 2

    for r in results:
        print(json.dumps(r, ensure_ascii=False))
    return 0 if results else 1


if __name__ == "__main__":
    raise SystemExit(main())
