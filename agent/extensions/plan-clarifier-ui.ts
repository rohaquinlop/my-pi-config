import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ClarifyOption {
	value?: string;
	label: string;
	description?: string;
	recommended?: boolean;
}

interface ClarifyQuestion {
	id: string;
	label?: string;
	prompt: string;
	why?: string;
	options: ClarifyOption[];
	allowMultiple?: boolean;
	allowCustom?: boolean;
	allowDigDeeper?: boolean;
	allowDelegate?: boolean;
}

interface RenderOption extends ResolvedOption {
	synthetic?: "custom" | "deeper" | "delegate";
}

type ResolvedOption = ClarifyOption & { value: string };
type ResolvedQuestion = Omit<ClarifyQuestion, "options" | "label" | "why"> & {
	label: string;
	why?: string;
	options: ResolvedOption[];
};

interface ClarifyAnswer {
	id: string;
	values: string[];
	labels: string[];
	customText?: string;
	requestDigDeeper?: boolean;
	delegated?: boolean;
}

interface ClarifyResult {
	cancelled: boolean;
	answers: ClarifyAnswer[];
}

const OptionSchema = Type.Object({
	value: Type.Optional(Type.String({ description: "Stable option value returned when selected. Defaults to label when omitted" })),
	label: Type.String({ description: "Human-readable option text" }),
	description: Type.Optional(Type.String({ description: "Short tradeoff/explanation" })),
	recommended: Type.Optional(Type.Boolean({ description: "Whether this option is recommended/preselected" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique question id" }),
	label: Type.Optional(Type.String({ description: "Short label for progress display" })),
	prompt: Type.String({ description: "Question to ask" }),
	why: Type.Optional(Type.String({ description: "Why this matters" })),
	options: Type.Array(OptionSchema, { description: "Concrete answer options. Put recommended option first when possible. Option value defaults to label when omitted." }),
	allowMultiple: Type.Optional(Type.Boolean({ description: "Allow choosing multiple options with Space" })),
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow authored answer" })),
	allowDigDeeper: Type.Optional(Type.Boolean({ description: "Allow user to request deeper follow-up" })),
	allowDelegate: Type.Optional(Type.Boolean({ description: "Allow user to leave decision to agent" })),
});

const ParamsSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Dialog title" })),
	questions: Type.Array(QuestionSchema, { description: "Clarification questions to ask" }),
});

function normalizeQuestions(raw: ClarifyQuestion[]): ResolvedQuestion[] {
	return raw.map((q, i) => ({
		id: q.id,
		label: q.label || `Q${i + 1}`,
		prompt: q.prompt,
		why: q.why,
		options: (q.options || []).map((o) => ({ ...o, value: o.value ?? o.label })),
		allowMultiple: q.allowMultiple === true,
		allowCustom: q.allowCustom !== false,
		allowDigDeeper: q.allowDigDeeper !== false,
		allowDelegate: q.allowDelegate !== false,
	}));
}

export default function planClarifierUi(pi: ExtensionAPI) {
	pi.registerTool({
		name: "clarification_ui",
		label: "Clarification UI",
		description:
			"Show an interactive TUI for clarification questions. Use when asking the user to choose plan-clarification answers. Supports ↑↓ navigation, Space toggle/select, Enter next, custom authored text, dig deeper, and leave-to-agent choices.",
		promptSnippet: "Interactive multiple-choice clarification UI with Space/Enter navigation",
		promptGuidelines: [
			"Use clarification_ui when plan-clarifier needs user choices; put the recommended option first and mark it recommended.",
			"After clarification_ui returns, summarize chosen answers and either ask deeper follow-up or produce the implementation brief.",
		],
		parameters: ParamsSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return { content: [{ type: "text", text: "Interactive UI unavailable." }], details: { cancelled: true, answers: [] } };
			}

			const questions = normalizeQuestions(params.questions as ClarifyQuestion[]);
			if (questions.length === 0) {
				return { content: [{ type: "text", text: "No clarification questions." }], details: { cancelled: true, answers: [] } };
			}

			const title = (params.title as string | undefined) || "Clarify plan";

			const result = await ctx.ui.custom<ClarifyResult>((tui, theme, _kb, done) => {
				let qIndex = 0;
				let cursor = 0;
				let inputMode = false;
				let cached: string[] | undefined;
				const selected = new Map<string, Set<string>>();
				const customText = new Map<string, string>();

				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function opts(q = questions[qIndex]): RenderOption[] {
					const base: RenderOption[] = [...q.options];
					if (q.allowCustom) base.push({ value: "__custom__", label: "Author custom answer", synthetic: "custom" });
					if (q.allowDigDeeper) base.push({ value: "__deeper__", label: "Dig deeper on this", synthetic: "deeper" });
					if (q.allowDelegate) base.push({ value: "__delegate__", label: "Leave it to agent", synthetic: "delegate" });
					return base;
				}

				function ensureDefault(q = questions[qIndex]) {
					if (selected.has(q.id)) return;
					const recommended = q.options.filter((o) => o.recommended).map((o) => o.value);
					const defaults = recommended.length ? recommended : q.options[0] ? [q.options[0].value] : [];
					selected.set(q.id, new Set(q.allowMultiple ? defaults : defaults.slice(0, 1)));
				}

				function refresh() {
					cached = undefined;
					tui.requestRender();
				}

				function currentSelection(): Set<string> {
					const q = questions[qIndex];
					ensureDefault(q);
					return selected.get(q.id)!;
				}

				function buildAnswers(): ClarifyAnswer[] {
					return questions.map((q) => {
						ensureDefault(q);
						const values = Array.from(selected.get(q.id) || []);
						const allOpts = opts(q);
						const labels = values.map((v) => allOpts.find((o) => o.value === v)?.label || v);
						return {
							id: q.id,
							values,
							labels,
							customText: customText.get(q.id),
							requestDigDeeper: values.includes("__deeper__"),
							delegated: values.includes("__delegate__"),
						};
					});
				}

				function finish(cancelled: boolean) {
					done({ cancelled, answers: cancelled ? [] : buildAnswers() });
				}

				function advance() {
					if (qIndex < questions.length - 1) {
						qIndex++;
						cursor = 0;
						ensureDefault();
						refresh();
					} else {
						finish(false);
					}
				}

				function toggleCurrent() {
					const q = questions[qIndex];
					const option = opts()[cursor];
					if (!option) return;
					if (option.synthetic === "custom") {
						inputMode = true;
						editor.setText(customText.get(q.id) || "");
						refresh();
						return;
					}

					const set = currentSelection();
					if (!q.allowMultiple) set.clear();
					if (set.has(option.value) && q.allowMultiple) set.delete(option.value);
					else set.add(option.value);
					refresh();
				}

				editor.onSubmit = (value) => {
					const q = questions[qIndex];
					const trimmed = value.trim();
					if (trimmed) customText.set(q.id, trimmed);
					const set = currentSelection();
					if (!q.allowMultiple) set.clear();
					set.add("__custom__");
					inputMode = false;
					refresh();
				};

				ensureDefault();

				function handleInput(data: string) {
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const list = opts();
					if (matchesKey(data, Key.up)) {
						cursor = Math.max(0, cursor - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						cursor = Math.min(list.length - 1, cursor + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.left) && qIndex > 0) {
						qIndex--;
						cursor = 0;
						refresh();
						return;
					}
					if (matchesKey(data, Key.right)) {
						advance();
						return;
					}
					if (matchesKey(data, Key.space)) {
						toggleCurrent();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						advance();
						return;
					}
					if (matchesKey(data, Key.escape)) finish(true);
				}

				function render(width: number): string[] {
					if (cached) return cached;
					const q = questions[qIndex];
					const set = currentSelection();
					const list = opts();
					const lines: string[] = [];
					const add = (s = "") => lines.push(truncateToWidth(s, width));
					const wrap = (s: string, color: string = "text") => {
						for (const line of wrapTextWithAnsi(theme.fg(color as any, s), Math.max(10, width - 2))) add(` ${line}`);
					};
					const wrapIndent = (s: string, color: string = "text", indent = 1) => {
						for (const line of wrapTextWithAnsi(theme.fg(color as any, s), Math.max(10, width - 2 - indent))) {
							add(" ".repeat(indent) + line);
						}
					};

					add(theme.fg("accent", "─".repeat(width)));
					add(theme.fg("accent", theme.bold(` ${title} `)) + theme.fg("dim", `(${qIndex + 1}/${questions.length})`));
					add(theme.fg("dim", ` ${questions.map((x, i) => (i === qIndex ? "●" : "○") + x.label).join("  ")}`));
					lines.push("");
					wrap(q.prompt);
					if (q.why) wrap(`Why: ${q.why}`, "muted");
					lines.push("");

					for (let i = 0; i < list.length; i++) {
						const o = list[i];
						const active = i === cursor;
						const checked = set.has(o.value);
						const mark = checked ? "[x]" : "[ ]";
						const prefix = active ? theme.fg("accent", "> ") : "  ";
						const rec = o.recommended || i === 0 && !o.synthetic ? theme.fg("success", "  ✅") : "";
						const text = `${mark} ${o.label}${rec}`;
						add(prefix + (active ? theme.fg("accent", text) : theme.fg("text", text)));
						if (o.description) wrapIndent(o.description, "muted", 5);
						if (o.synthetic === "custom" && customText.has(q.id)) wrapIndent(customText.get(q.id)!, "muted", 5);
					}

					if (inputMode) {
						lines.push("");
						add(theme.fg("muted", " Custom answer:"));
						for (const line of editor.render(Math.max(10, width - 2))) add(` ${line}`);
					}

					lines.push("");
					add(theme.fg("dim", " ↑↓ move • Space choose/toggle • Enter next/submit • ← previous • Esc cancel"));
					add(theme.fg("accent", "─".repeat(width)));
					cached = lines;
					return lines;
				}

				return { render, invalidate: () => { cached = undefined; }, handleInput };
			});

			if (result.cancelled) {
				return { content: [{ type: "text", text: "User cancelled clarification UI." }], details: result };
			}

			const text = result.answers
				.map((a) => {
					const extra = a.customText ? ` — custom: ${a.customText}` : "";
					return `${a.id}: ${a.labels.join(", ")}${extra}`;
				})
				.join("\n");

			return { content: [{ type: "text", text }], details: result };
		},

		renderCall(args, theme) {
			const count = Array.isArray((args as any).questions) ? (args as any).questions.length : 0;
			return new Text(`${theme.fg("toolTitle", theme.bold("clarification_ui"))} ${theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ClarifyResult | undefined;
			if (!details || details.cancelled) return new Text(theme.fg("warning", "Clarification cancelled"), 0, 0);
			return new Text(details.answers.map((a) => `${theme.fg("success", "✓")} ${theme.fg("accent", a.id)}: ${a.labels.join(", ")}`).join("\n"), 0, 0);
		},
	});
}
