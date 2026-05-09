#!/usr/bin/env python3
"""Fetch URL into temp dir and extract readable text when possible."""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import ssl
import tempfile
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (compatible; pi-web-research/1.0; +https://pi.dev)"


class TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "canvas"}
    BLOCK = {"p", "div", "section", "article", "header", "footer", "main", "li", "br", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "td", "th"}

    def __init__(self) -> None:
        super().__init__()
        self.skip_depth = 0
        self.parts: list[str] = []
        self.title_parts: list[str] = []
        self.in_title = False

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[no-untyped-def]
        tag = tag.lower()
        if tag in self.SKIP:
            self.skip_depth += 1
        if tag == "title":
            self.in_title = True
        if tag in self.BLOCK:
            self.parts.append("\n")
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.parts.append(f" [link: {href}] ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.SKIP and self.skip_depth:
            self.skip_depth -= 1
        if tag == "title":
            self.in_title = False
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        if self.in_title:
            self.title_parts.append(data)
        self.parts.append(data)

    def text(self) -> str:
        s = "".join(self.parts)
        s = re.sub(r"[ \t\r\f\v]+", " ", s)
        s = re.sub(r"\n[ \t]+", "\n", s)
        s = re.sub(r"\n{3,}", "\n\n", s)
        return s.strip()

    def title(self) -> str:
        return re.sub(r"\s+", " ", " ".join(self.title_parts)).strip()


def safe_name(url: str, content_type: str) -> str:
    parsed = urllib.parse.urlparse(url)
    base = os.path.basename(parsed.path.rstrip("/")) or parsed.netloc or "download"
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base)[:80]
    ext = os.path.splitext(base)[1]
    if not ext:
        ext = mimetypes.guess_extension(content_type.split(";", 1)[0].strip()) or ".bin"
    digest = hashlib.sha256(url.encode()).hexdigest()[:10]
    return f"{base}.{digest}{ext}" if not base.endswith(ext) else f"{base}.{digest}{ext}"


def ssl_context(insecure: bool = False):
    if insecure:
        return ssl._create_unverified_context()  # explicit user opt-in
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch URL to temp dir and extract text")
    ap.add_argument("url")
    ap.add_argument("--workdir")
    ap.add_argument("--max-bytes", type=int, default=5_000_000)
    ap.add_argument("--raw", action="store_true")
    ap.add_argument("--insecure", action="store_true", help="Disable TLS certificate verification")
    args = ap.parse_args()

    workdir = args.workdir or tempfile.mkdtemp(prefix="pi-web-research-")
    os.makedirs(workdir, exist_ok=True)

    req = urllib.request.Request(args.url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,text/plain,application/json,*/*;q=0.8"})
    with urllib.request.urlopen(req, timeout=30, context=ssl_context(args.insecure)) as r:  # nosec - user-driven research tool
        status = getattr(r, "status", None)
        final_url = r.geturl()
        content_type = r.headers.get("content-type", "application/octet-stream")
        body = r.read(args.max_bytes + 1)

    truncated = len(body) > args.max_bytes
    if truncated:
        body = body[: args.max_bytes]

    raw_path = os.path.join(workdir, safe_name(final_url, content_type))
    with open(raw_path, "wb") as f:
        f.write(body)

    text_path = None
    title = ""
    ctype = content_type.lower()
    if not args.raw and ("html" in ctype or raw_path.endswith((".html", ".htm"))):
        decoded = body.decode("utf-8", "replace")
        ex = TextExtractor()
        ex.feed(decoded)
        title = ex.title()
        text_path = raw_path + ".txt"
        with open(text_path, "w", encoding="utf-8") as f:
            f.write(f"URL: {final_url}\nTitle: {title}\nContent-Type: {content_type}\n\n{ex.text()}\n")
    elif not args.raw and ("text/" in ctype or "json" in ctype or raw_path.endswith((".txt", ".md", ".json", ".csv", ".xml"))):
        text_path = raw_path + ".txt"
        with open(text_path, "w", encoding="utf-8") as f:
            f.write(body.decode("utf-8", "replace"))

    print(json.dumps({
        "workdir": workdir,
        "url": args.url,
        "final_url": final_url,
        "status": status,
        "content_type": content_type,
        "truncated": truncated,
        "raw_path": raw_path,
        "text_path": text_path,
        "title": title,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
