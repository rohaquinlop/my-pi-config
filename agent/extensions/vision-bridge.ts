/**
 * Vision Bridge Extension
 *
 * Lets text-only models (input: ["text"]) "see" user-attached images by
 * delegating to a vision-capable model.
 *
 * When the user attaches an image while the active model lacks the "image"
 * input capability, this extension:
 *   1. saves the image to a session temp directory (content-hash filename),
 *   2. sends it to a vision model (auto-picked, or set via /vision-bridge-model),
 *   3. replaces the image in the turn with the vision model's text description,
 *   4. keeps the saved path available for targeted follow-up questions via the
 *      read_image tool.
 *
 * Descriptions are cached per image hash for the session, so re-attaching the
 * same image costs no extra vision call. Temp files are removed on
 * session_shutdown.
 *
 * Commands:
 *   /vision-bridge-model <provider/model-id>   set the bridge vision model
 *   /vision-bridge-status                      show bridge state
 *
 * Tool:
 *   read_image(path, question?)                ask the vision model about a saved image
 */

import type {
	AssistantMessage,
	ImageContent,
	Model,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Type } from "typebox";

const BRIDGE_ENTRY = "vision-bridge";

const DESCRIBE_PROMPT = `You are the vision component of a coding agent whose main model cannot see images.
Describe the attached image thoroughly and factually, so the main model can work with it without ever seeing it.
Include, when present: the overall layout, all visible text verbatim (code, labels, UI elements, error messages), colors, icons, diagrams, and any notable details.
If the image is a screenshot, describe what the screen shows as precisely as you can. Be complete; do not summarize away detail the main model might need.`;

const QUESTION_PROMPT = `You are the vision component of a coding agent whose main model cannot see images.
Answer the user's question about the attached image precisely, quoting visible text verbatim when relevant.`;

const MIME_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"image/bmp": ".bmp",
	"image/svg+xml": ".svg",
};

interface BridgeState {
	overrideModelId?: string;
}

// --- module state (session-scoped) ---

/** image hash -> description */
const cache = new Map<string, string>();
let overrideModelId: string | undefined;
let notifiedNoVision = false;
let currentSessionDir: string | undefined;

// --- helpers ---

function hashData(data: string): string {
	return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

function extName(mimeType: string): string {
	return MIME_EXT[mimeType] ?? ".img";
}

function mimeFromPath(filePath: string): string | undefined {
	const ext = extname(filePath).toLowerCase();
	for (const [mime, e] of Object.entries(MIME_EXT)) {
		if (e === ext) return mime;
	}
	return undefined;
}

function savedImagesDir(sessionId: string): string {
	return join(tmpdir(), "pi-vision-bridge", sessionId);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Extract joined text from an assistant message; throw if the call failed. */
function extractText(message: AssistantMessage): string {
	if (message.errorMessage) throw new Error(message.errorMessage);
	const text = message.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n")
		.trim();
	if (!text) throw new Error("vision model returned no text");
	return text;
}

/** Resolve the bridge's vision model: override first, then auto-pick. */
function resolveVisionModel(ctx: ExtensionContext): Model<any> | undefined {
	const registry = ctx.modelRegistry;
	if (overrideModelId) {
		const [provider, id] = overrideModelId.split("/");
		const model = provider && id ? registry.find(provider, id) : undefined;
		if (model && model.input.includes("image")) return model;
		console.warn(`[vision-bridge] override ${overrideModelId} no longer resolves; falling back to auto-pick`);
	}
	const vision = registry.getAvailable().filter((m) => m.input.includes("image"));
	if (vision.length === 0) return undefined;
	const activeProvider = ctx.model?.provider;
	if (activeProvider) {
		const sameProvider = vision.find((m) => m.provider === activeProvider);
		if (sameProvider) return sameProvider;
	}
	return vision[0];
}

/** Call the vision model with an image and optional question. Throws on failure. */
async function describeImage(
	ctx: ExtensionContext,
	model: Model<any>,
	image: ImageContent,
	question: string | undefined,
): Promise<string> {
	const content = [
		...(question ? [{ type: "text" as const, text: question }] : []),
		{ type: "image" as const, data: image.data, mimeType: image.mimeType },
	];
	const userMessage: UserMessage = { role: "user", content, timestamp: Date.now() };
	const result = await ctx.modelRegistry.complete(
		model,
		{ systemPrompt: question ? QUESTION_PROMPT : DESCRIBE_PROMPT, messages: [userMessage] },
		{ signal: ctx.signal },
	);
	return extractText(result);
}

/** Last override from the current branch, if any. */
function loadOverride(ctx: ExtensionContext): string | undefined {
	let found: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === BRIDGE_ENTRY) {
			const data = entry.data as BridgeState | undefined;
			if (data?.overrideModelId) found = data.overrideModelId;
		}
	}
	return found;
}

export default function (pi: ExtensionAPI): void {
	// --- session lifecycle ---

	pi.on("session_start", async (_event, ctx) => {
		cache.clear();
		notifiedNoVision = false;
		overrideModelId = loadOverride(ctx);
		currentSessionDir = savedImagesDir(ctx.sessionManager.getSessionId());
	});

	pi.on("session_shutdown", async () => {
		if (currentSessionDir) {
			await rm(currentSessionDir, { recursive: true, force: true });
			currentSessionDir = undefined;
		}
	});

	// --- auto-describe attached images ---

	pi.on("input", async (event, ctx) => {
		if (!event.images || event.images.length === 0) return { action: "continue" as const };
		const active = ctx.model;
		if (!active || active.input.includes("image")) return { action: "continue" as const };

		const visionModel = resolveVisionModel(ctx);
		if (!visionModel) {
			if (!notifiedNoVision) {
				notifiedNoVision = true;
				ctx.ui.notify(
					"Vision bridge: no vision-capable model available. Attached images were left untouched.",
					"error",
				);
			}
			return { action: "continue" as const };
		}

		const dir = savedImagesDir(ctx.sessionManager.getSessionId());
		await mkdir(dir, { recursive: true });

		const blocks: string[] = [];
		for (const image of event.images) {
			const hash = hashData(image.data);
			const fileName = `${hash}${extName(image.mimeType)}`;
			const filePath = join(dir, fileName);

			let description = cache.get(hash);
			if (description === undefined) {
				try {
					// persist the raw image for read_image follow-ups
					try {
						await writeFile(filePath, Buffer.from(image.data, "base64"));
					} catch (error) {
						console.warn(`[vision-bridge] failed to save ${filePath}: ${errorMessage(error)}`);
					}
					description = await describeImage(ctx, visionModel, image, undefined);
					cache.set(hash, description);
				} catch (error) {
					description = `[Vision bridge: ${visionModel.provider}/${visionModel.id} failed to read this image: ${errorMessage(error)}]`;
				}
			}
			blocks.push(`--- Image ${fileName} (saved at ${filePath}) ---\n${description}`);
		}

		const text =
			`${event.text}\n\n[Vision bridge]\n${blocks.join("\n\n")}\n\n` +
			`The user attached ${event.images.length} image(s). The active model (${active.provider}/${active.id}) ` +
			`cannot receive images, so the vision model (${visionModel.provider}/${visionModel.id}) described them above. ` +
			`Use the read_image tool with path=<saved path> and an optional question to ask for details the description missed.`;

		return { action: "transform" as const, text, images: [] };
	});

	// --- read_image tool: targeted follow-up questions ---

	pi.registerTool({
		name: "read_image",
		label: "Read Image",
		description:
			"Ask the vision model to read an image saved by the vision bridge and answer a question about it, or describe it again. Use a path returned by the vision bridge.",
		parameters: Type.Object({
			path: Type.String({ description: "Path of the saved image, as shown by the vision bridge" }),
			question: Type.Optional(
				Type.String({ description: "Optional targeted question about the image" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = savedImagesDir(ctx.sessionManager.getSessionId());
			const resolved = resolve(params.path);
			if (resolved !== dir && !resolved.startsWith(dir + "/")) {
				return {
					content: [
						{
							type: "text" as const,
							text: "read_image: path is not a vision-bridge saved image. Use a path returned by the vision bridge.",
						},
					],
					details: {},
					isError: true,
				};
			}

			const visionModel = resolveVisionModel(ctx);
			if (!visionModel) {
				return {
					content: [
						{
							type: "text" as const,
							text: "read_image: no vision model available. Configure one with /vision-bridge-model.",
						},
					],
					details: {},
					isError: true,
				};
			}

			let data: Buffer;
			try {
				data = await readFile(resolved);
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `read_image: cannot read image: ${errorMessage(error)}` }],
					details: {},
					isError: true,
				};
			}

			try {
				const answer = await describeImage(
					ctx,
					visionModel,
					{
						type: "image",
						data: data.toString("base64"),
						mimeType: mimeFromPath(resolved) ?? "image/png",
					},
					params.question,
				);
				return { content: [{ type: "text" as const, text: answer }], details: {} };
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `read_image: ${visionModel.provider}/${visionModel.id} failed: ${errorMessage(error)}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// --- commands ---

	pi.registerCommand("vision-bridge-model", {
		description: "Set the vision model used by the vision bridge (provider/model-id)",
		handler: async (args, ctx) => {
			const id = args?.trim();
			if (!id) {
				ctx.ui.notify("Usage: /vision-bridge-model <provider/model-id>", "error");
				return;
			}
			const [provider, modelId] = id.split("/");
			const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
			if (!model) {
				ctx.ui.notify(`Vision bridge: unknown model "${id}"`, "error");
				return;
			}
			if (!model.input.includes("image")) {
				ctx.ui.notify(`Vision bridge: model "${id}" does not accept images`, "error");
				return;
			}
			overrideModelId = id;
			pi.appendEntry<BridgeState>(BRIDGE_ENTRY, { overrideModelId: id });
			ctx.ui.notify(`Vision bridge model set to ${id}`, "info");
		},
	});

	pi.registerCommand("vision-bridge-status", {
		description: "Show vision bridge state",
		handler: async (_args, ctx) => {
			const active = ctx.model;
			const visionModel = resolveVisionModel(ctx);
			const lines = [
				`Active model: ${active ? `${active.provider}/${active.id}` : "none"}`,
				`Vision capability: ${active ? (active.input.includes("image") ? "yes" : "no") : "n/a"}`,
				`Bridge override: ${overrideModelId ?? "none (auto)"}`,
				`Resolved bridge model: ${visionModel ? `${visionModel.provider}/${visionModel.id}` : "none"}`,
				`Cache entries: ${cache.size}`,
				`Session dir: ${savedImagesDir(ctx.sessionManager.getSessionId())}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
