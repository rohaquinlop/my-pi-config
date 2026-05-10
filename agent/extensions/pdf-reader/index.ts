/**
 * PDF Reader Tool
 *
 * Adds `read_pdf` so the agent can extract text from PDF files.
 */

import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse") as (data: Buffer, options?: { pagerender?: (pageData: any) => Promise<string> }) => Promise<{
	numpages: number;
	numrender: number;
	info?: Record<string, unknown>;
	metadata?: unknown;
	text: string;
}>;

const PdfParams = Type.Object({
	path: Type.String({ description: "PDF file path, absolute or relative to current working directory" }),
	pages: Type.Optional(Type.Array(Type.Number(), { description: "Optional 1-based page numbers to extract, e.g. [1,2,5]" })),
	maxPages: Type.Optional(Type.Number({ description: "Optional maximum number of pages to extract from the start or selected pages" })),
});

interface PdfDetails {
	path: string;
	fileName: string;
	pages: number;
	renderedPages: number;
	selectedPages?: number[];
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

function normalizeText(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.trim();
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read_pdf",
		label: "Read PDF",
		description: `Extract text from a PDF file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. If truncated, full text is saved to a temp file.`,
		parameters: PdfParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = resolve(ctx.cwd, params.path);
			const selectedPages = params.pages?.length
				? Array.from(new Set(params.pages.map((page) => Math.trunc(page)).filter((page) => page > 0))).sort((a, b) => a - b)
				: undefined;
			const maxPages = params.maxPages && params.maxPages > 0 ? Math.trunc(params.maxPages) : undefined;
			const limitedSelectedPages = selectedPages && maxPages ? selectedPages.slice(0, maxPages) : selectedPages;

			let pageIndex = 0;
			const data = await readFile(filePath);
			const parsed = await pdfParse(data, {
				pagerender: async (pageData: any) => {
					pageIndex += 1;
					if (limitedSelectedPages && !limitedSelectedPages.includes(pageIndex)) return "";
					if (!limitedSelectedPages && maxPages && pageIndex > maxPages) return "";

					const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
					const text = content.items.map((item: { str?: string }) => item.str || "").join(" ");
					return `\n\n--- Page ${pageIndex} ---\n${text}`;
				},
			});

			let output = normalizeText(parsed.text);
			if (!output) output = "[No extractable text found. The PDF may be scanned/image-only.]";

			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: PdfDetails = {
				path: filePath,
				fileName: basename(filePath),
				pages: parsed.numpages,
				renderedPages: parsed.numrender,
				selectedPages: limitedSelectedPages,
			};

			let resultText = truncation.content;
			if (truncation.truncated) {
				const tempDir = await mkdtemp(resolve(tmpdir(), "pi-pdf-"));
				const tempFile = resolve(tempDir, `${basename(filePath)}.txt`);
				await withFileMutationQueue(tempFile, async () => writeFile(tempFile, output, "utf8"));

				details.truncation = truncation;
				details.fullOutputPath = tempFile;
				resultText += `\n\n[PDF text truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full text saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("read_pdf "));
			text += theme.fg("accent", args.path || "<missing path>");
			if (args.pages?.length) text += theme.fg("dim", ` pages ${args.pages.join(",")}`);
			if (args.maxPages) text += theme.fg("dim", ` max ${args.maxPages}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Extracting PDF text..."), 0, 0);
			const details = result.details as PdfDetails | undefined;
			if (!details) return new Text(theme.fg("error", "PDF read failed"), 0, 0);

			let text = theme.fg("success", `${details.fileName}: ${details.pages} pages`);
			if (details.selectedPages?.length) text += theme.fg("dim", ` (${details.selectedPages.length} selected)`);
			if (details.truncation?.truncated) text += theme.fg("warning", " truncated");

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					text += "\n" + theme.fg("dim", content.text.split("\n").slice(0, 40).join("\n"));
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
