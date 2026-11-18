/**
 * Canonical Cursor tool presentation metadata.
 * Names, labels, visibility, replay, lifecycle, web remapping, and alias normalization
 * derive from this registry — do not duplicate tool lists in sibling modules.
 */

import {
	MCP_SUMMARY_SEPARATOR,
	formatReplaySemSearchQuery,
	readCursorReplaySummaryString,
	summarizeReplayGenericActivity,
	summarizeReplayMcp,
	summarizeReplayPath,
	summarizeReplayPlan,
	summarizeReplayReadLints,
	summarizeReplayRecordScreen,
	summarizeReplayTask,
	summarizeReplayTodoCount,
	withActivitySummaryFallback,
	type CursorReplayActivitySummaryOverride,
	type CursorReplayGenerateImageSummaryArgs,
	type CursorReplaySummaryArgs,
	type CursorReplayWebFetchSummaryArgs,
	type CursorReplayWebSearchSummaryArgs,
} from "./cursor-replay-summary-args.js";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";
import { previewFromLine, previewFromText } from "./cursor-structured-summary.js";
import { getCursorTaskActivityTitle } from "./cursor-task-presentation.js";
import {
	buildCreatePlanReplaySummaryArgs,
	buildDeleteReplayDetailFields,
	buildDeleteReplaySummaryArgs,
	buildGenerateImageReplayDetailFields,
	buildGenerateImageReplaySummaryArgs,
	buildMcpReplaySummaryArgs,
	buildReadLintsReplaySummaryArgs,
	buildRecordScreenReplaySummaryArgs,
	buildSemSearchReplaySummaryArgs,
	buildTaskReplaySummaryArgs,
	buildTodoReplaySummaryArgs,
	buildWebFetchReplaySummaryArgs,
	buildWebSearchReplaySummaryArgs,
	type CursorReplayActivityBuildContext,
} from "./cursor-replay-activity-builders.js";
import type { CursorReplaySourceToolName } from "./cursor-replay-source-names.js";
import type {
	CursorReplayActivityDetailFields,
	CursorReplayGenerateImageDetailFields,
} from "./cursor-replay-tool-details.js";

export const CURSOR_REPLAY_ACTIVITY_TOOL_NAME = "cursor" as const;

const EMPTY_REPLAY_DETAIL_FIELDS = (): Record<string, never> => ({});
const COLLAPSED_REPLAY_DETAIL_FIELDS = (): { collapseDetailsByDefault: true } => ({ collapseDetailsByDefault: true });

/** Line `readMcpDisplayResult` prefixes a tool-error body with; it names no outcome of its own. */
const MCP_TOOL_ERROR_MARKER = "[tool error]";

/**
 * Brings a recorded MCP summary to the shape this spec writes today.
 *
 * Earlier versions put the first 120 characters of the result after the ` · ` separator, which for
 * JSON produced an opening fragment such as `[{"name":"sonarqube_analyze`. A recorded preview that is
 * already intelligible is what the writer meant, so it is kept. When it is only a fragment, the
 * payload in `expandedText` is read for a name instead.
 */
function normalizeMcpActivitySummary(summary: string, expandedText?: string): string {
	const separator = summary.indexOf(MCP_SUMMARY_SEPARATOR);
	const toolName = (separator === -1 ? summary : summary.slice(0, separator)).trim();
	if (!toolName) return summary.trim();

	const recorded = separator === -1 ? undefined : summary.slice(separator + MCP_SUMMARY_SEPARATOR.length).trim();
	const recordedPreview = recorded ? previewFromLine(recorded, 120) : undefined;
	if (recordedPreview && recordedPreview !== toolName) {
		return `${toolName}${MCP_SUMMARY_SEPARATOR}${recordedPreview}`;
	}

	const recovered = expandedText ? mcpPreviewFromExpandedText(toolName, expandedText) : undefined;
	if (recovered && recovered !== toolName) return `${toolName}${MCP_SUMMARY_SEPARATOR}${recovered}`;
	return toolName;
}

/**
 * Preview re-derived from a recorded payload.
 *
 * `formatMcp` writes `toolName`, a blank line, then the body, so the text after the title is the one
 * the write path would have previewed. The tool-error marker is skipped because it labels the body
 * without describing it.
 */
function mcpPreviewFromExpandedText(toolName: string, expandedText: string): string | undefined {
	const lines = expandedText.split("\n");
	const start = lines.findIndex((line) => line.trim() === toolName);
	const body = (start === -1 ? lines : lines.slice(start + 1))
		.filter((line) => line.trim() && line.trim() !== MCP_TOOL_ERROR_MARKER)
		.join("\n");
	return body ? previewFromText(body, 120) : undefined;
}

export type CursorWebToolKind = "webSearch" | "webFetch";

export type CursorToolLifecycleLabelKind =
	| "task"
	| "shell"
	| "mcp"
	| "generateImage"
	| "recordScreen"
	| "semSearch"
	| "webSearch"
	| "webFetch"
	| "createPlan"
	| "updateTodos";

export type CursorReplayCallSummaryBuilder<T extends CursorReplayActivitySummaryOverride = CursorReplaySummaryArgs> = (
	args: T | undefined,
) => string | undefined;

export interface CursorToolVisibilityPolicy {
	incompleteTitle?: string;
	lifecycleTitle?: string;
	lifecycleEligible?: boolean;
	fastLocalDiscovery?: boolean;
}

export interface CursorToolReplayDisplayPolicy {
	showCollapsedExpandHint?: boolean;
	/**
	 * Rewrites a recorded activity summary before it is drawn.
	 *
	 * Rows written before a spec changed its summary shape keep the old text in the session file, so
	 * the spec owns turning that text into what it would write today. The recorded payload is passed
	 * too, because a truncated summary is often not enough to recover a name. Returning the input
	 * unchanged leaves the summary alone.
	 */
	normalizeActivitySummary?: (summary: string, expandedText?: string) => string;
}

export interface CursorToolActivityReplaySpec<TArgs extends CursorReplaySummaryArgs = CursorReplaySummaryArgs> {
	buildActivityArgs: (context: CursorReplayActivityBuildContext) => TArgs;
	buildDetails: (context: CursorReplayActivityBuildContext, contentText: string) => CursorReplayActivityDetailFields;
	/**
	 * Whether a collapsed row shows its summary alone instead of previewing the payload.
	 *
	 * Rows recorded before a spec set this carry no flag of their own, and the renderer consults the
	 * current spec for them. Keep it a data field rather than metadata on `buildDetails`, so a spec
	 * that collapses new rows cannot silently leave old rows expanded.
	 */
	collapseDetailsByDefault?: true;
}

export interface CursorToolGenerateImageReplaySpec {
	buildActivityArgs: (context: CursorReplayActivityBuildContext) => CursorReplayGenerateImageSummaryArgs;
	buildDetails: (context: CursorReplayActivityBuildContext, contentText: string) => CursorReplayGenerateImageDetailFields;
}

export interface CursorToolPresentationSpec {
	normalizedName: CursorReplaySourceToolName;
	/** Raw SDK/host names that resolve to this tool via {@link normalizeCursorToolName}. */
	nameAliases?: readonly string[];
	displayLabel: string;
	getActivityTitle?: () => string;
	visibility: CursorToolVisibilityPolicy;
	replayDisplay?: CursorToolReplayDisplayPolicy;
	webKind?: CursorWebToolKind;
	/** Regexes matched against lowercased trimmed tool names for {@link classifyCursorWebToolKind}. */
	webNamePatterns?: readonly RegExp[];
	lifecycleLabelKind?: CursorToolLifecycleLabelKind;
	replayCallSummary?: CursorReplayCallSummaryBuilder;
	activityReplay?: CursorToolActivityReplaySpec;
	generateImageReplay?: CursorToolGenerateImageReplaySpec;
}

const WEB_SEARCH_NAME_PATTERN =
	/^(?:web[-_ ]?search|search[-_ ]?web|websearch|browser[-_ ]?search)$/i;
const WEB_FETCH_NAME_PATTERN =
	/^(?:web[-_ ]?fetch|fetch[-_ ]?web|webfetch|browser[-_ ]?fetch|fetch[-_ ]?url)$/i;

const CURSOR_TOOL_PRESENTATION_SPECS = [
	{
		normalizedName: "read",
		nameAliases: ["read_file"],
		displayLabel: "read",
		visibility: { incompleteTitle: "Cursor read", fastLocalDiscovery: true },
	},
	{
		normalizedName: "grep",
		nameAliases: ["grep_search", "search"],
		displayLabel: "grep",
		visibility: { incompleteTitle: "Cursor grep", fastLocalDiscovery: true },
	},
	{
		normalizedName: "glob",
		nameAliases: ["file_search"],
		displayLabel: "glob",
		visibility: { incompleteTitle: "Cursor find", fastLocalDiscovery: true },
	},
	{
		normalizedName: "ls",
		nameAliases: ["list_dir"],
		displayLabel: "ls",
		visibility: { incompleteTitle: "Cursor ls", fastLocalDiscovery: true },
	},
	{
		normalizedName: "shell",
		nameAliases: ["run_terminal_cmd", "terminal", "bash"],
		displayLabel: "shell",
		visibility: {
			incompleteTitle: "Cursor shell",
			lifecycleTitle: "Cursor shell",
			lifecycleEligible: true,
		},
		lifecycleLabelKind: "shell",
	},
	{
		normalizedName: "edit",
		nameAliases: [
			"strreplace",
			"str_replace",
			"str-replace",
			"edit_file",
			"editfile",
			"edit_notebook",
			"editnotebook",
			"notebook_edit",
			"notebookedit",
		],
		displayLabel: "Cursor edit",
		visibility: {},
		replayCallSummary: withActivitySummaryFallback(summarizeReplayPath),
	},
	{
		normalizedName: "write",
		nameAliases: ["write_file", "writefile"],
		displayLabel: "Cursor write",
		visibility: {},
		replayCallSummary: withActivitySummaryFallback(summarizeReplayPath),
	},
	{
		normalizedName: "delete",
		displayLabel: "Cursor delete",
		visibility: {},
		replayCallSummary: withActivitySummaryFallback(summarizeReplayPath),
		activityReplay: {
			buildActivityArgs: buildDeleteReplaySummaryArgs,
			buildDetails: buildDeleteReplayDetailFields,
		},
	},
	{
		normalizedName: "readLints",
		displayLabel: "Cursor diagnostics",
		visibility: {},
		replayCallSummary: withActivitySummaryFallback(summarizeReplayReadLints),
		activityReplay: {
			buildActivityArgs: buildReadLintsReplaySummaryArgs,
			buildDetails: EMPTY_REPLAY_DETAIL_FIELDS,
		},
	},
	{
		normalizedName: "updateTodos",
		displayLabel: "Cursor todos",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "updateTodos",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayTodoCount),
		activityReplay: {
			buildActivityArgs: ({ args, result }) => buildTodoReplaySummaryArgs(args, result),
			buildDetails: EMPTY_REPLAY_DETAIL_FIELDS,
		},
	},
	{
		normalizedName: "createPlan",
		displayLabel: "Cursor plan",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "createPlan",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayPlan),
		activityReplay: {
			buildActivityArgs: buildCreatePlanReplaySummaryArgs,
			buildDetails: EMPTY_REPLAY_DETAIL_FIELDS,
		},
	},
	{
		normalizedName: "task",
		displayLabel: "Cursor subagent",
		getActivityTitle: getCursorTaskActivityTitle,
		visibility: { lifecycleEligible: true },
		replayDisplay: { showCollapsedExpandHint: true },
		lifecycleLabelKind: "task",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayTask),
		activityReplay: {
			buildActivityArgs: buildTaskReplaySummaryArgs,
			buildDetails: EMPTY_REPLAY_DETAIL_FIELDS,
		},
	},
	{
		normalizedName: "generateImage",
		displayLabel: "Cursor image generation",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "generateImage",
		replayCallSummary: withActivitySummaryFallback((args: CursorReplayGenerateImageSummaryArgs | undefined) =>
			readCursorReplaySummaryString(args, "path") ?? readCursorReplaySummaryString(args, "prompt"),
		),
		generateImageReplay: {
			buildActivityArgs: buildGenerateImageReplaySummaryArgs,
			buildDetails: buildGenerateImageReplayDetailFields,
		},
	},
	{
		normalizedName: "mcp",
		displayLabel: "Cursor MCP",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "mcp",
		replayDisplay: { normalizeActivitySummary: normalizeMcpActivitySummary },
		replayCallSummary: withActivitySummaryFallback(summarizeReplayMcp),
		activityReplay: {
			buildActivityArgs: buildMcpReplaySummaryArgs,
			// MCP results are full payloads, often tens of thousands of characters of JSON. Collapsed
			// rows must show the summary alone, as web search and fetch already do.
			buildDetails: COLLAPSED_REPLAY_DETAIL_FIELDS,
			collapseDetailsByDefault: true,
		},
	},
	{
		normalizedName: "semSearch",
		displayLabel: "Cursor semantic search",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "semSearch",
		replayCallSummary: withActivitySummaryFallback(formatReplaySemSearchQuery),
		activityReplay: {
			buildActivityArgs: buildSemSearchReplaySummaryArgs,
			buildDetails: EMPTY_REPLAY_DETAIL_FIELDS,
		},
	},
	{
		normalizedName: "recordScreen",
		displayLabel: "Cursor screen recording",
		visibility: { lifecycleEligible: true },
		lifecycleLabelKind: "recordScreen",
		replayCallSummary: withActivitySummaryFallback(summarizeReplayRecordScreen),
		activityReplay: {
			buildActivityArgs: buildRecordScreenReplaySummaryArgs,
			buildDetails: EMPTY_REPLAY_DETAIL_FIELDS,
		},
	},
	{
		normalizedName: "webSearch",
		nameAliases: ["websearch", "web_search", "web-search"],
		displayLabel: "Cursor web search",
		visibility: { lifecycleEligible: true },
		webKind: "webSearch",
		webNamePatterns: [WEB_SEARCH_NAME_PATTERN],
		lifecycleLabelKind: "webSearch",
		replayCallSummary: withActivitySummaryFallback((args: CursorReplayWebSearchSummaryArgs | undefined) =>
			readCursorReplaySummaryString(args, "query"),
		),
		activityReplay: {
			buildActivityArgs: buildWebSearchReplaySummaryArgs,
			buildDetails: COLLAPSED_REPLAY_DETAIL_FIELDS,
			collapseDetailsByDefault: true,
		},
	},
	{
		normalizedName: "webFetch",
		nameAliases: ["webfetch", "web_fetch", "web-fetch"],
		displayLabel: "Cursor web fetch",
		visibility: { lifecycleEligible: true },
		webKind: "webFetch",
		webNamePatterns: [WEB_FETCH_NAME_PATTERN],
		lifecycleLabelKind: "webFetch",
		replayCallSummary: withActivitySummaryFallback((args: CursorReplayWebFetchSummaryArgs | undefined) =>
			readCursorReplaySummaryString(args, "url"),
		),
		activityReplay: {
			buildActivityArgs: buildWebFetchReplaySummaryArgs,
			buildDetails: COLLAPSED_REPLAY_DETAIL_FIELDS,
			collapseDetailsByDefault: true,
		},
	},
] as const satisfies readonly CursorToolPresentationSpec[];

type CursorToolPresentationSpecEntry = (typeof CURSOR_TOOL_PRESENTATION_SPECS)[number];

export type CursorNormalizedToolName = CursorReplaySourceToolName;
export type CursorReplayToolName = typeof CURSOR_REPLAY_ACTIVITY_TOOL_NAME;

type CursorToolPresentationSpecWithNeutralActivity = Extract<
	CursorToolPresentationSpecEntry,
	{ readonly activityReplay: CursorToolActivityReplaySpec } | { readonly generateImageReplay: CursorToolGenerateImageReplaySpec }
> | Extract<CursorToolPresentationSpecEntry, { readonly normalizedName: "edit" | "write" }>;

export type CursorReplayActivityToolName = CursorToolPresentationSpecWithNeutralActivity["normalizedName"];

function hasNeutralActivityTitle(spec: CursorToolPresentationSpec): boolean {
	return Boolean(spec.activityReplay || spec.generateImageReplay || spec.normalizedName === "edit" || spec.normalizedName === "write");
}

const SPECS_BY_NORMALIZED_NAME = new Map<string, CursorToolPresentationSpec>(
	CURSOR_TOOL_PRESENTATION_SPECS.map((spec) => [spec.normalizedName, spec]),
);

const SPECS_BY_NORMALIZED_KEY = new Map<string, CursorToolPresentationSpec>(
	CURSOR_TOOL_PRESENTATION_SPECS.map((spec) => [spec.normalizedName.toLowerCase(), spec]),
);

const ALIAS_TO_NORMALIZED_NAME = new Map<string, CursorNormalizedToolName>(
	CURSOR_TOOL_PRESENTATION_SPECS.flatMap((spec) => {
		const aliases = "nameAliases" in spec ? spec.nameAliases : undefined;
		return (aliases ?? []).map((alias) => [alias.toLowerCase(), spec.normalizedName] as const);
	}),
);

const WEB_KIND_BY_PATTERN = CURSOR_TOOL_PRESENTATION_SPECS.flatMap((spec) => {
	if (!("webKind" in spec) || !("webNamePatterns" in spec)) return [];
	const { webKind, webNamePatterns } = spec;
	if (!webKind || !webNamePatterns) return [];
	return webNamePatterns.map((pattern) => ({ pattern, webKind }));
});

function getCursorToolPresentationSpec(
	name: string,
): CursorToolPresentationSpec | undefined {
	const trimmed = name.trim();
	if (!trimmed) return undefined;
	return SPECS_BY_NORMALIZED_NAME.get(trimmed) ?? SPECS_BY_NORMALIZED_KEY.get(trimmed.toLowerCase());
}

export function normalizeCursorToolName(name: string): string {
	const normalized = name.replace(/\s+/g, " ").trim();
	if (!normalized) return "unknown";
	const aliasTarget = ALIAS_TO_NORMALIZED_NAME.get(normalized.toLowerCase());
	if (aliasTarget) return aliasTarget;
	const spec = getCursorToolPresentationSpec(normalized);
	if (spec) return spec.normalizedName;
	return normalized;
}

export function classifyCursorWebToolKind(name: string | undefined): CursorWebToolKind | undefined {
	if (!name) return undefined;
	const normalized = name.replace(/\s+/g, " ").trim().toLowerCase();
	for (const { pattern, webKind } of WEB_KIND_BY_PATTERN) {
		if (pattern.test(normalized)) return webKind;
	}
	const spec = getCursorToolPresentationSpec(name);
	return spec?.webKind;
}

export function isCursorReplayToolName(toolName: string): toolName is CursorReplayToolName {
	return toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME;
}

export function isExcludedFromCursorBridgeExposure(toolName: string): boolean {
	return toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME;
}

export function getCursorReplayPromptLabel(toolName: string): string {
	return toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME ? "Cursor activity" : toolName;
}

export function getCursorReplayActivityTitle(toolName: string): string | undefined {
	const spec = getCursorToolPresentationSpec(toolName);
	if (!spec || !hasNeutralActivityTitle(spec)) return undefined;
	return spec.getActivityTitle?.() ?? spec.displayLabel;
}

function buildCursorGenericActivityTitle(displayName: string): string {
	if (!displayName || displayName === "unknown") return "Cursor tool";
	return `Cursor ${truncateCursorDisplayLine(displayName, 120)}`;
}

/** Canonical activity title: registry label when known, otherwise neutral fallback. */
export function getCursorToolActivityTitle(toolName: string): string {
	const normalized = normalizeCursorToolName(toolName);
	const known = getCursorReplayActivityTitle(normalized);
	if (known) return known;
	const label = toolName.trim() || normalized;
	return buildCursorGenericActivityTitle(label);
}

function getCursorToolPresentationSpecByNormalizedKey(normalizedKey: string): CursorToolPresentationSpec | undefined {
	return SPECS_BY_NORMALIZED_KEY.get(normalizedKey.toLowerCase());
}

export function getCursorToolVisibilityPolicy(normalizedKey: string): CursorToolVisibilityPolicy | undefined {
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.visibility;
}

export function getCursorToolLifecycleLabelKind(normalizedKey: string): CursorToolLifecycleLabelKind | undefined {
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.lifecycleLabelKind;
}

export function getCursorToolActivityReplaySpec(normalizedKey: string): CursorToolActivityReplaySpec | undefined {
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.activityReplay;
}

export function getCursorToolGenerateImageReplaySpec(normalizedKey: string): CursorToolGenerateImageReplaySpec | undefined {
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.generateImageReplay;
}

/**
 * Whether this tool's activity rows collapse their details by default, per the current spec.
 *
 * Renderers use this for rows recorded before the spec collapsed anything: the row carries no flag,
 * but the spec still says the payload belongs behind `ctrl+o`.
 */
export function collapsesActivityDetailsByDefault(normalizedKey: string | undefined): boolean {
	if (!normalizedKey) return false;
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.activityReplay?.collapseDetailsByDefault === true;
}

/** Applies the spec's summary rewrite, if it has one, to a recorded summary and its payload. */
export function normalizeCursorReplayActivitySummary(
	normalizedKey: string | undefined,
	summary: string,
	expandedText?: string,
): string {
	if (!normalizedKey) return summary;
	const normalize = getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.replayDisplay?.normalizeActivitySummary;
	return normalize ? normalize(summary, expandedText) : summary;
}

export function shouldShowCursorReplayCollapsedExpandHint(normalizedKey: string | undefined): boolean {
	if (!normalizedKey) return false;
	return getCursorToolPresentationSpecByNormalizedKey(normalizedKey)?.replayDisplay?.showCollapsedExpandHint === true;
}

export function getCursorReplayCallSummary(
	toolName: CursorReplayToolName | CursorReplaySourceToolName,
	args: CursorReplaySummaryArgs | undefined,
): string | undefined {
	if (toolName === CURSOR_REPLAY_ACTIVITY_TOOL_NAME) {
		return readCursorReplaySummaryString(args, "activitySummary") ?? summarizeReplayGenericActivity(args);
	}
	return getCursorToolPresentationSpec(toolName)?.replayCallSummary?.(args);
}
