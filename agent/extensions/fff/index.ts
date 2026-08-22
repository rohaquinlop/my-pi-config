/**
 * pi-fff-local: FFF-powered file search extension for pi
 *
 * Provides ultra-fast file find (`fffind`) and content grep (`ffgrep`) tools
 * backed by FFF's Rust engine — frecency-ranked, git-aware, typo-resistant
 * search that outperforms ripgrep/fzf on repeated-search workloads.
 *
 * Tools: ffgrep, fffind, fff-multi-grep
 * @-mention autocomplete is always enabled.
 *
 * Env vars: FFF_FRECENCY_DB, FFF_HISTORY_DB, FFF_ENABLE_ROOT_SCAN
 * Flags: --fff-frecency-db, --fff-history-db, --fff-enable-root-scan
 *
 * Dependencies:
 *   - @ff-labs/fff-node: Native FFF Node.js SDK (wraps Rust cdylib)
 *
 * After installing deps with `npm install` in this directory, reload pi
 * and the tools are available.
 */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type {
  GrepCursor,
  GrepMode,
  GrepResult,
  MixedItem,
  SearchResult,
} from "@ff-labs/fff-node";
import { FileFinder } from "@ff-labs/fff-node";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";

// ── Path resolution helpers ────────────────────────────────────────────

interface ResolvedConstraint {
  root: string;
  constraint: string | null;
}

/** Walk up from target until an existing directory is found (file → dirname). */
function deepestExistingAncestor(target: string): string {
  let dir = path.resolve(target);
  for (;;) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // fall through to parent
    }
    const parent = path.dirname(dir);
    if (parent === dir) return dir; // filesystem root
    dir = parent;
  }
}

// ── Query building helpers ──────────────────────────────────────────────

function normalizePathConstraint(
  pathConstraint: string,
  cwd = process.cwd(),
): ResolvedConstraint | null {
  let trimmed = pathConstraint.trim();
  if (!trimmed) return null;

  let root = cwd;

  if (path.isAbsolute(trimmed)) {
    const relative = path.relative(cwd, trimmed).replaceAll(path.sep, "/");
    if (relative === "") return null;
    if (relative.startsWith("../") || relative === "..") {
      // Outside the workspace: index the deepest existing ancestor.
      const target = path.resolve(trimmed);
      root = deepestExistingAncestor(target);
      trimmed = path.relative(root, target).replaceAll(path.sep, "/");
      if (trimmed === "" || trimmed === ".") return { root, constraint: null };
    } else {
      trimmed = relative;
    }
  } else {
    // Relative constraint: detect workspace escapes (../) and treat them as external roots.
    const target = path.resolve(cwd, trimmed);
    const relFromCwd = path.relative(cwd, target).replaceAll(path.sep, "/");
    if (relFromCwd.startsWith("../") || relFromCwd === "..") {
      root = deepestExistingAncestor(target);
      trimmed = path.relative(root, target).replaceAll(path.sep, "/");
      if (trimmed === "" || trimmed === ".") return { root, constraint: null };
    }
  }

  if (trimmed === "." || trimmed === "./") return { root, constraint: null };
  if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

  const recursiveDir = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
  if (recursiveDir) {
    const dir = recursiveDir[1];
    if (dir && !/[*?[{]/.test(dir)) {
      return { root, constraint: `${dir}/` };
    }
  }

  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return { root, constraint: trimmed };
  if (/[*?[{]/.test(trimmed)) return { root, constraint: trimmed };
  const lastSegment = trimmed.split("/").pop() ?? "";
  if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return { root, constraint: trimmed };
  return { root, constraint: `${trimmed}/` };
}

function normalizeExcludes(
  exclude: string | string[] | undefined,
  root: string,
): string[] {
  if (!exclude) return [];
  const list = Array.isArray(exclude) ? exclude : [exclude];
  const out: string[] = [];
  for (const raw of list) {
    const parts = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const stripped = p.startsWith("!") ? p.slice(1) : p;
      const resolved = path.isAbsolute(stripped) ? stripped : path.resolve(root, stripped);
      if (path.relative(root, resolved).startsWith("..")) continue; // escapes root — skip
      const normalized = normalizePathConstraint(stripped, root);
      if (normalized?.constraint) out.push(`!${normalized.constraint}`);
    }
  }
  return out;
}

interface BuiltQuery {
  query: string;
  root: string;
}

/**
 * Resolve the search root from a multi-grep filter string. If the first token
 * is an absolute path (or a relative path escaping the workspace), that token
 * designates the external root and is stripped from the filter passed to the
 * engine. Otherwise the filter is passed through untouched (workspace root).
 */
function resolveRootFromFilter(
  filter: string | undefined,
  cwd: string,
): { root: string; filter: string | undefined } {
  if (!filter) return { root: cwd, filter: undefined };
  const trimmed = filter.trim();
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0];
  if (!first) return { root: cwd, filter: undefined };
  const target = path.isAbsolute(first) ? path.resolve(first) : path.resolve(cwd, first);
  const relFromCwd = path.relative(cwd, target);
  const escapes = relFromCwd === ".." || relFromCwd.startsWith("../");
  if (escapes) {
    const root = deepestExistingAncestor(target);
    const rest = tokens.slice(1).join(" ");
    return { root, filter: rest || undefined };
  }
  return { root: cwd, filter: trimmed };
}

function buildQuery(
  pathConstraint: string | undefined,
  pattern: string,
  exclude?: string | string[],
  cwd = process.cwd(),
): BuiltQuery {
  let root = cwd;
  const parts: string[] = [];
  if (pathConstraint) {
    const resolved = normalizePathConstraint(pathConstraint, cwd);
    if (resolved) {
      root = resolved.root;
      if (resolved.constraint) parts.push(resolved.constraint);
    }
  }
  parts.push(...normalizeExcludes(exclude, root));
  parts.push(pattern);
  return { query: parts.join(" "), root };
}

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_MAX_LINE_LENGTH = 500;
const MENTION_MAX_RESULTS = 20;



// ── Cursor store — bounded Map for pagination cursors ──────────────────

interface StoredGrepCursor {
  cursor: GrepCursor;
  root: string;
}

const cursorCache = new Map<string, StoredGrepCursor>();
let cursorCounter = 0;

function storeCursor(cursor: GrepCursor, root: string): string {
  const id = `fff_c${++cursorCounter}`;
  cursorCache.set(id, { cursor, root });
  if (cursorCache.size > 200) {
    const first = cursorCache.keys().next().value;
    if (first) cursorCache.delete(first);
  }
  return id;
}

function getCursor(id: string): StoredGrepCursor | undefined {
  return cursorCache.get(id);
}

interface FindCursor {
  query: string;
  pattern: string;
  pageSize: number;
  nextPageIndex: number;
  root: string;
}

const findCursorCache = new Map<string, FindCursor>();
let findCursorCounter = 0;

function storeFindCursor(cursor: FindCursor): string {
  const id = `${++findCursorCounter}`;
  findCursorCache.set(id, cursor);
  if (findCursorCache.size > 200) {
    const first = findCursorCache.keys().next().value;
    if (first) findCursorCache.delete(first);
  }
  return id;
}

function getFindCursor(id: string): FindCursor | undefined {
  return findCursorCache.get(id);
}

// ── Output formatting ──────────────────────────────────────────────────

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trimEnd();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

function fffFileAnnotation(item: {
  gitStatus?: string;
  totalFrecencyScore?: number;
  accessFrecencyScore?: number;
}): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown" && git !== "") {
    return `  [${git} in git]`;
  }
  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
  if (frecency >= WARM_FRECENCY) return "  [often touched file]";
  return "";
}

function formatGrepOutput(result: GrepResult, pathPrefix = ""): string {
  if (result.items.length === 0) return "No matches found";

  const lines: string[] = [];
  let currentFile = "";

  for (const match of result.items) {
    const filePath = pathPrefix + match.relativePath;
    if (filePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = filePath;
      lines.push(`${filePath}${fffFileAnnotation(match)}`);
    }

    match.contextBefore?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber - match.contextBefore!.length + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });

    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

    match.contextAfter?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber + 1 + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });
  }

  return lines.join("\n");
}

const FIND_WEAK_SAMPLE_SIZE = 5;

function weakScoreThreshold(pattern: string): number {
  const perfect = pattern.length * 12;
  return Math.floor((perfect * 50) / 100);
}

interface FormattedFind {
  output: string;
  weak: boolean;
  shownCount: number;
}

function formatFindOutput(
  result: SearchResult,
  limit: number,
  pattern: string,
  pathPrefix = "",
): FormattedFind {
  if (result.items.length === 0) {
    return { output: "No files found matching pattern", weak: false, shownCount: 0 };
  }

  const topScore = result.scores[0]?.total ?? 0;
  const weak = topScore < weakScoreThreshold(pattern);
  const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
  const shown = result.items.slice(0, effective);

  return {
    output: shown
      .map((item) => `${pathPrefix}${item.relativePath}${fffFileAnnotation(item)}`)
      .join("\n"),
    weak,
    shownCount: shown.length,
  };
}

// ── Mention autocomplete ──────────────────────────────────────────────

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
  return match?.[1] ?? null;
}

function buildAtCompletionValue(relPath: string): string {
  return relPath.includes(" ") ? `@"${relPath}"` : `@${relPath}`;
}

function createFffMentionProvider(
  getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] || "";
      const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
      if (!prefix || options.signal.aborted) return null;

      const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
      const items = await getItems(query, options.signal);
      return options.signal.aborted || items.length === 0 ? null : { items, prefix };
    },
    applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = _lines[cursorLine] || "";
      const before = currentLine.slice(0, cursorCol - prefix.length);
      const after = currentLine.slice(cursorCol);
      const newLine = before + item.value + after;
      const newCursorCol = cursorCol - prefix.length + item.value.length;
      return {
        lines: [..._lines.slice(0, cursorLine), newLine, ..._lines.slice(cursorLine + 1)],
        cursorLine,
        cursorCol: newCursorCol,
      };
    },
  };
}

// ── Extension ──────────────────────────────────────────────────────────

export default function fffExtension(pi: ExtensionAPI) {
  let finder: FileFinder | null = null;
  let finderCwd: string | null = null;
  let finderPromise: Promise<FileFinder> | null = null;
  let activeCwd = process.cwd();

  const frecencyDbPath =
    (pi.getFlag("fff-frecency-db") as string | undefined) ??
    process.env.FFF_FRECENCY_DB ??
    undefined;
  const historyDbPath =
    (pi.getFlag("fff-history-db") as string | undefined) ??
    process.env.FFF_HISTORY_DB ??
    undefined;

  function resolveBoolOpt(flagName: string, envName: string): boolean {
    const flag = pi.getFlag(flagName);
    if (typeof flag === "boolean") return flag;
    if (typeof flag === "string") return flag === "true" || flag === "1";
    const env = process.env[envName];
    return env === "1" || env === "true";
  }
  const enableFsRootScanning = resolveBoolOpt(
    "fff-enable-root-scan",
    "FFF_ENABLE_ROOT_SCAN",
  );

  const ALT_LRU_MAX = 3;
  const ALT_IDLE_TTL_MS = 10 * 60 * 1000;
  interface AltFinderEntry {
    finder: FileFinder;
    lastUsed: number;
  }
  const altFinders = new Map<string, AltFinderEntry>();

  async function ensureFinder(cwd: string): Promise<FileFinder> {
    if (finder && !finder.isDestroyed && finderCwd === cwd)
      return Promise.resolve(finder);
    if (finderPromise) return finderPromise;

    finderPromise = (async () => {
      if (finder && !finder.isDestroyed) {
        finder.destroy();
        finder = null;
        finderCwd = null;
      }

      const result = FileFinder.create({
        basePath: cwd,
        frecencyDbPath,
        historyDbPath,
        aiMode: true,
        enableHomeDirScanning: true,
        enableFsRootScanning,
      });

      if (!result.ok)
        throw new Error(`Failed to create FFF file finder: ${result.error}`);

      finder = result.value;
      finderCwd = cwd;
      await finder.waitForScan(15000);
      return finder;
    })().finally(() => {
      finderPromise = null;
    });

    return finderPromise;
  }

  /** Get a finder for an arbitrary root: session cwd uses the watcher-enabled finder; other roots get a cached, un-watched finder. */
  async function getFinderForRoot(root: string): Promise<FileFinder> {
    if (root === activeCwd) return ensureFinder(root);

    const now = Date.now();
    // Idle TTL sweep
    for (const [r, entry] of altFinders) {
      if (now - entry.lastUsed > ALT_IDLE_TTL_MS) {
        if (!entry.finder.isDestroyed) entry.finder.destroy();
        altFinders.delete(r);
      }
    }

    const existing = altFinders.get(root);
    if (existing && !existing.finder.isDestroyed) {
      existing.lastUsed = now;
      return existing.finder;
    }

    const result = FileFinder.create({
      basePath: root,
      frecencyDbPath,
      historyDbPath,
      aiMode: true,
      enableHomeDirScanning: true,
      enableFsRootScanning,
      disableWatch: true,
    });

    if (!result.ok)
      throw new Error(
        `Failed to create FFF file finder for ${root}: ${result.error}`,
      );

    const altFinder = result.value;
    await altFinder.waitForScan(15000);

    // LRU eviction
    if (altFinders.size >= ALT_LRU_MAX) {
      const lru = [...altFinders.entries()].sort(
        (a, b) => a[1].lastUsed - b[1].lastUsed,
      )[0];
      if (lru) {
        if (!lru[1].finder.isDestroyed) lru[1].finder.destroy();
        altFinders.delete(lru[0]);
      }
    }

    altFinders.set(root, { finder: altFinder, lastUsed: Date.now() });
    return altFinder;
  }

  function destroyFinder() {
    if (finder && !finder.isDestroyed) {
      finder.destroy();
      finder = null;
      finderCwd = null;
    }
    for (const [, entry] of altFinders) {
      if (!entry.finder.isDestroyed) entry.finder.destroy();
    }
    altFinders.clear();
  }

  async function getMentionItems(
    query: string,
    signal: AbortSignal,
  ): Promise<AutocompleteItem[]> {
    if (signal.aborted) return [];
    const f = await ensureFinder(activeCwd);
    if (signal.aborted) return [];

    const result = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
    if (!result.ok) return [];

    return result.value.items.slice(0, MENTION_MAX_RESULTS).map((mixed: MixedItem) => {
      if (mixed.type === "directory") {
        return {
          value: buildAtCompletionValue(mixed.item.relativePath),
          label: mixed.item.dirName,
          description: mixed.item.relativePath,
        };
      }
      return {
        value: buildAtCompletionValue(mixed.item.relativePath),
        label: mixed.item.fileName,
        description: mixed.item.relativePath,
      };
    });
  }

  function registerAutocompleteProvider(ctx: {
    ui: {
      addAutocompleteProvider: (
        factory: (current: AutocompleteProvider) => AutocompleteProvider,
      ) => void;
    };
  }) {
    ctx.ui.addAutocompleteProvider((current) => {
      const mentionProvider = createFffMentionProvider(getMentionItems);

      return {
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          try {
              const mentionResult = await mentionProvider.getSuggestions(
                lines,
                cursorLine,
                cursorCol,
                options,
              );
              if (mentionResult) return mentionResult;
            } catch {
              // Delegate when FFF lookup is unavailable.
            }
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return (
            current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
          );
        },
      };
    });
  }

  // ── Flags ────────────────────────────────────────────────────────────

  pi.registerFlag("fff-frecency-db", {
    description: "Path to the frecency database (overrides FFF_FRECENCY_DB env)",
    type: "string",
  });

  pi.registerFlag("fff-history-db", {
    description: "Path to the query history database (overrides FFF_HISTORY_DB env)",
    type: "string",
  });

  pi.registerFlag("fff-enable-root-scan", {
    description:
      "Allow indexing when launched from the filesystem root (also: FFF_ENABLE_ROOT_SCAN env)",
    type: "boolean",
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      activeCwd = ctx.cwd;

      registerAutocompleteProvider(ctx);
      await ensureFinder(activeCwd);
    } catch (e: unknown) {
      ctx.ui.notify(
        `FFF init failed: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    destroyFinder();
  });

  // ── Shared render helper ─────────────────────────────────────────────

  /** Check if a tool result is a blocked-call message (should not render). */
  function isBlockedResult(content: unknown): boolean {
    if (!content || typeof content !== "object") return false;
    const text = (content as any).text;
    return typeof text === "string" && (
      text.startsWith("__PI_INTERNAL_BLOCKED__") ||
      text.startsWith("__PI_BLOCKED__") ||
      text.includes("is blocked to protect your context window") ||
      text.includes("Broad code searches bloat your context")
    );
  }

  /** Strip the internal blocked prefix from content text for clean display. */
  function stripBlockedPrefix(content: unknown): void {
    if (!content || typeof content !== "object") return;
    const c = content as any;
    if (typeof c.text !== "string") return;
    if (c.text.startsWith("__PI_INTERNAL_BLOCKED__")) {
      c.text = c.text.slice("__PI_INTERNAL_BLOCKED__".length);
    } else if (c.text.startsWith("__PI_BLOCKED__")) {
      c.text = c.text.slice("__PI_BLOCKED__".length);
    }
  }

  const renderTextResult = (
    result: { content?: { type: string; text?: string }[] },
    options: { expanded?: boolean },
    theme: any,
    context: any,
    maxLines = 15,
  ) => {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    const contentItem = result.content?.find((c) => c.type === "text");
    if (contentItem && isBlockedResult(contentItem)) {
      stripBlockedPrefix(contentItem);
      text.setText("");
      return text;
    }
    const output = contentItem?.text?.trim() ?? "";
    if (!output) {
      text.setText(theme.fg("muted", "No output"));
      return text;
    }
    const lines = output.split("\n");
    const displayLines = lines.slice(0, options.expanded ? lines.length : maxLines);
    let content = `\n${displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n")}`;
    if (lines.length > displayLines.length) {
      content += theme.fg(
        "muted",
        `\n... (${lines.length - displayLines.length} more lines)`,
      );
    }
    text.setText(content);
    return text;
  };

  // ── ffgrep tool ──────────────────────────────────────────────────────

  const grepSchema = Type.Object({
    pattern: Type.String({
      description: "Search pattern (literal text or regex)",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Path constraint relative to the workspace: directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Absolute paths outside the workspace are supported: the tool indexes that directory and returns absolute paths.",
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix (test/), filename with extension (config.json), or glob (*.min.js, **/*.{rs,go}). A leading ! is optional and ignored. Example: test/,*.min.js,!vendor/.",
      }),
    ),
    caseSensitive: Type.Optional(
      Type.Boolean({
        description:
          "Force case-sensitive matching. Default uses smart-case (case-insensitive when pattern is all lowercase).",
      }),
    ),
    context: Type.Optional(
      Type.Number({ description: "Context lines before+after each match" }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Max matches (default ${DEFAULT_GREP_LIMIT})` }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor from previous result" }),
    ),
  });

  pi.registerTool({
    name: "ffgrep",
    label: "ffgrep",
    description: `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Absolute paths outside the workspace are supported and return absolute paths (first such query builds a temporary index). Default limit ${DEFAULT_GREP_LIMIT}.`,
    promptSnippet: "Grep contents",
    promptGuidelines: [
      "Prefer bare identifiers as patterns. Literal queries are most efficient.",
      "Use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').",
      "caseSensitive: true when you need exact case (smart-case otherwise).",
      "After 1-2 greps, read the top match instead of more greps.",
      "For files outside the workspace, pass an absolute path in 'path' — results come back absolute.",
    ],
    parameters: grepSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const storedCursor = params.cursor ? getCursor(params.cursor) : undefined;
      const built = buildQuery(params.path, params.pattern, params.exclude, activeCwd);
      const root = storedCursor?.root ?? built.root;
      const f = await getFinderForRoot(root);
      const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      const query = built.query;

      const hasRegexSyntax =
        params.pattern !== params.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      let mode: GrepMode = hasRegexSyntax ? "regex" : "plain";
      if (mode === "regex") {
        try {
          new RegExp(params.pattern);
        } catch {
          mode = "plain";
        }
      }

      // Guard: reject wildcard-only regex
      const p = params.pattern.trim();
      const isWildcardOnly =
        hasRegexSyntax &&
        /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(p);

      if (isWildcardOnly) {
        return {
          content: [
            {
              type: "text",
              text: "Pattern matches everything \u2014 grep needs a concrete substring or identifier. Example: `pattern: 'MyClass'` or `pattern: 'export function'`.",
            },
          ],
          details: { totalMatched: 0, totalFiles: 0, truncation: undefined },
        };
      }

      const smartCase = params.caseSensitive !== true;

      const grepResult = f.grep(query, {
        mode,
        smartCase,
        maxMatchesPerFile: Math.min(effectiveLimit, 50),
        cursor: storedCursor?.cursor ?? null,
        beforeContext: params.context ?? 0,
        afterContext: params.context ?? 0,
        classifyDefinitions: true,
      });

      if (!grepResult.ok) throw new Error(grepResult.error);

      let result = grepResult.value;
      let fuzzyNotice: string | null = null;

      // Automatic fuzzy fallback on zero exact matches
      if (result.items.length === 0 && !params.cursor && mode !== "regex") {
        const fuzzy = f.grep(params.pattern, {
          mode: "fuzzy",
          smartCase,
          maxMatchesPerFile: Math.min(effectiveLimit, 50),
          cursor: null,
          beforeContext: 0,
          afterContext: 0,
          classifyDefinitions: true,
        });

        if (fuzzy.ok && fuzzy.value.items.length > 0) {
          fuzzyNotice = "0 exact matches. Maybe you meant this?";
          result = fuzzy.value;
        }
      }

      const pathPrefix = root === activeCwd ? "" : `${root}/`;
      let output = formatGrepOutput(result, pathPrefix);
      const notices: string[] = [];
      if (result.regexFallbackError) {
        notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
      }
      if (result.nextCursor) {
        notices.push(`Continue with cursor="${storeCursor(result.nextCursor, root)}"`);
      }

      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

      const grepTrunc = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
      let truncatedOutput = grepTrunc.content;
      if (grepTrunc.truncated) {
        truncatedOutput += `\n\n...[truncated: showing ${grepTrunc.outputLines} of ${grepTrunc.totalLines} lines`;
        truncatedOutput += ` (${formatSize(grepTrunc.outputBytes)} of ${formatSize(grepTrunc.totalBytes)}).`;
        truncatedOutput += ` Use fewer matches or less context to reduce output]`;
      }

      return {
        content: [{ type: "text", text: truncatedOutput }],
        details: { totalMatched: result.totalMatched, totalFiles: result.totalFiles, truncation: grepTrunc.truncated ? grepTrunc : undefined },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern = args?.pattern ?? "";
      const pathArg = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold("ffgrep")) +
        " " +
        theme.fg("accent", `/${pattern}/`) +
        theme.fg("toolOutput", ` in ${pathArg}`);
      if (args?.limit !== undefined) content += theme.fg("toolOutput", ` limit ${args.limit}`);
      if (args?.cursor) content += theme.fg("muted", " (page)");
      text.setText(content);
      return text;
    },

    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 15);
    },
  });

  // ── fffind tool ──────────────────────────────────────────────────────

  const findSchema = Type.Object({
    pattern: Type.String({
      description:
        "Fuzzy filename search and glob search. Frecency-ranked, git-aware. Multi-word = narrower (AND) not bound to order. Prefer this over ls/find/bash as the first exploration step whenever the user names a concept, feature, or symbol.",
    }),
    path: Type.Optional(
      Type.String({
        description:
          "Path constraint relative to the workspace: directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Absolute paths outside the workspace are supported: the tool indexes that directory and returns absolute paths.",
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Exclude paths (comma/space-separated or array). Same syntax as path. Example: test/,*.min.js,!vendor/.",
      }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Max results per page (default ${DEFAULT_FIND_LIMIT})` }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor from previous result" }),
    ),
  });

  pi.registerTool({
    name: "fffind",
    label: "fffind",
    description: `Fuzzy path search and glob search. Matches against the whole workspace-relative path, not just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Absolute paths outside the workspace are supported and return absolute paths (first such query builds a temporary index). Default limit ${DEFAULT_FIND_LIMIT}.`,
    promptSnippet: "Find files by path or glob",
    promptGuidelines: [
      "Matches the WHOLE path, not just the filename \u2014 `profile` hits `chrome/browser/profiles/x.cc` too.",
      "Keep queries to 1-2 terms; extra words narrow.",
      "For exact path matches use a glob in `path` \u2014 e.g. path: '**/profile.h' for exact filename, or path: 'src/**/profile.h' scoped to a subtree.",
      "Use exclude: 'test/,*.min.js' to cut noise in large repos.",
      "For files outside the workspace, pass an absolute path in 'path' — results come back absolute.",
    ],
    parameters: findSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const resumed = params.cursor ? getFindCursor(params.cursor) : undefined;
      const effectiveLimit = resumed
        ? resumed.pageSize
        : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
      const built = resumed
        ? undefined
        : buildQuery(params.path, params.pattern, params.exclude, activeCwd);
      const root = resumed ? resumed.root : (built?.root ?? activeCwd);
      const query = resumed ? resumed.query : (built?.query ?? params.pattern);
      const pattern = resumed ? resumed.pattern : params.pattern;
      const pageIndex = resumed?.nextPageIndex ?? 0;
      const f = await getFinderForRoot(root);

      const searchResult = f.fileSearch(query, {
        pageIndex,
        pageSize: effectiveLimit,
      });
      if (!searchResult.ok) throw new Error(searchResult.error);

      const result = searchResult.value;
      const pathPrefix = root === activeCwd ? "" : `${root}/`;
      const formatted = formatFindOutput(result, effectiveLimit, pattern, pathPrefix);
      let output = formatted.output;

      const shownSoFar = pageIndex * effectiveLimit + result.items.length;
      const hasMore =
        result.items.length >= effectiveLimit && result.totalMatched > shownSoFar;

      const notices: string[] = [];
      if (formatted.weak && formatted.shownCount > 0) {
        notices.push(
          `Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`,
        );
      }

      if (!formatted.weak && hasMore) {
        const remaining = result.totalMatched - shownSoFar;
        const cursorId = storeFindCursor({
          query,
          pattern,
          pageSize: effectiveLimit,
          nextPageIndex: pageIndex + 1,
          root,
        });
        notices.push(
          `${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`,
        );
      }

      if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
      return {
        content: [{ type: "text", text: output }],
        details: { totalMatched: result.totalMatched, totalFiles: result.totalFiles, pageIndex, hasMore },
      };
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const pattern = args?.pattern ?? "";
      const pathArg = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold("fffind")) +
        " " +
        theme.fg("accent", pattern) +
        theme.fg("toolOutput", ` in ${pathArg}`);
      if (args?.limit !== undefined) content += theme.fg("toolOutput", ` (limit ${args.limit})`);
      if (args?.cursor) content += theme.fg("muted", " (page)");
      text.setText(content);
      return text;
    },

    renderResult(result, options, theme, context) {
      return renderTextResult(result, options, theme, context, 20);
    },
  });

  // ── Multi-grep tool (opt-in via PI_FFF_MULTIGREP=1) ─────────────────

  if (process.env.PI_FFF_MULTIGREP === "1") {
    const multiGrepSchema = Type.Object({
      patterns: Type.Array(Type.String(), {
        description: "Literal patterns (OR). Include snake_case/camelCase/PascalCase variants.",
      }),
      constraints: Type.Optional(
        Type.String({
          description:
            "File filter, e.g. '*.{ts,tsx} !test/'. An absolute path (or ../ escape) as the first token targets that external root; the rest of the filter applies within it. All patterns in one call share one root.",
        }),
      ),
      context: Type.Optional(Type.Number({ description: "Context lines before+after" })),
      limit: Type.Optional(
        Type.Number({ description: `Max matches (default ${DEFAULT_GREP_LIMIT})` }),
      ),
      cursor: Type.Optional(Type.String({ description: "Pagination cursor" })),
    });

    pi.registerTool({
      name: "fff-multi-grep",
      label: "fff-multi-grep",
      description:
        "Search file contents for ANY of multiple literal patterns (OR, SIMD Aho-Corasick). Faster than regex alternation. Absolute external roots supported via a leading absolute path in constraints (results absolute).",
      promptSnippet: "Multi-pattern OR content search",
      promptGuidelines: [
        "Use when searching for several identifiers at once.",
        "Include all naming-convention variants (snake/camel/Pascal).",
        "Patterns are literal. Use constraints for file filters.",
      ],
      parameters: multiGrepSchema,

      async execute(_toolCallId, params, signal) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (!params.patterns?.length) throw new Error("patterns array must have at least 1 element");

        const storedCursor = params.cursor ? getCursor(params.cursor) : undefined;
        const resolvedFilter = storedCursor
          ? { root: storedCursor.root, filter: params.constraints }
          : resolveRootFromFilter(params.constraints, activeCwd);
        const f = await getFinderForRoot(resolvedFilter.root);
        const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);

        const grepResult = f.multiGrep({
          patterns: params.patterns,
          constraints: resolvedFilter.filter,
          maxMatchesPerFile: Math.min(effectiveLimit, 50),
          smartCase: true,
          cursor: storedCursor?.cursor ?? null,
          beforeContext: params.context ?? 0,
          afterContext: params.context ?? 0,
        });

        if (!grepResult.ok) throw new Error(grepResult.error);

        const result = grepResult.value;
        const pathPrefix = resolvedFilter.root === activeCwd ? "" : `${resolvedFilter.root}/`;
        let output = formatGrepOutput(result, pathPrefix);
        const notices: string[] = [];
        if (result.items.length >= effectiveLimit) {
          notices.push(`${effectiveLimit}+ matches (refine patterns)`);
        }
        if (result.nextCursor) {
          notices.push(`More available. cursor="${storeCursor(result.nextCursor, resolvedFilter.root)}" to continue`);
        }
        if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

        const multiGrepTrunc = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
        let truncatedOutput = multiGrepTrunc.content;
        if (multiGrepTrunc.truncated) {
          truncatedOutput += `\n\n...[truncated: showing ${multiGrepTrunc.outputLines} of ${multiGrepTrunc.totalLines} lines`;
          truncatedOutput += ` (${formatSize(multiGrepTrunc.outputBytes)} of ${formatSize(multiGrepTrunc.totalBytes)}).`;
          truncatedOutput += ` Use fewer matches or less context to reduce output]`;
        }

        return {
          content: [{ type: "text", text: truncatedOutput }],
          details: { totalMatched: result.totalMatched, totalFiles: result.totalFiles, patterns: params.patterns, truncation: multiGrepTrunc.truncated ? multiGrepTrunc : undefined },
        };
      },

      renderCall(args, theme, context) {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const patterns = args?.patterns ?? [];
        const constraints = args?.constraints;
        let content =
          theme.fg("toolTitle", theme.bold("fff-multi-grep")) +
          " " +
          theme.fg("accent", patterns.map((p: string) => `"${p}"`).join(", "));
        if (constraints) content += theme.fg("toolOutput", ` (${constraints})`);
        if (args?.cursor) content += theme.fg("muted", " (page)");
        text.setText(content);
        return text;
      },

      renderResult(result, options, theme, context) {
        return renderTextResult(result, options, theme, context, 15);
      },
    });
  }

  // ── Commands ─────────────────────────────────────────────────────────



  pi.registerCommand("fff-health", {
    description: "Show FFF file finder health and status",
    handler: async (_args, ctx) => {
      if (!finder || finder.isDestroyed) {
        ctx.ui.notify("FFF not initialized", "warning");
        return;
      }

      const health = finder.healthCheck();
      if (!health.ok) {
        ctx.ui.notify(`Health check failed: ${health.error}`, "error");
        return;
      }

      const h = health.value;
      const lines = [
        `FFF v${h.version}`,
        `Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
        `Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
        `Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
        `Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
      ];

      const progress = finder.getScanProgress();
      if (progress.ok) {
        lines.push(
          `Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("fff-rescan", {
    description: "Trigger FFF to rescan files",
    handler: async (_args, ctx) => {
      if (!finder || finder.isDestroyed) {
        ctx.ui.notify("FFF not initialized", "warning");
        return;
      }
      const result = finder.scanFiles();
      if (!result.ok) {
        ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
        return;
      }
      ctx.ui.notify("FFF rescan triggered", "info");
    },
  });
}
