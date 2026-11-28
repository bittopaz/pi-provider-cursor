import { Cursor, type ModelListItem, type ModelParameterDefinition, type ModelSelection } from "@cursor/sdk";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { readCachedCursorModels, writeCachedCursorModels } from "./cursor-model-cache.js";

export const FALLBACK_CURSOR_MODEL_ID = "grok-4.6";

const THINKING_PARAMETER_IDS = ["reasoning", "reasoning_effort", "effort", "thinking"] as const;
const THINKING_PARAMETER_KEY = "cursorThinkingParameter";
const CONTEXT_PARAMETER_KEY = "cursorContextParameter";
const CONTEXT_VALUE_KEY = "cursorContextValue";
const FAST_PARAMETER_KEY = "cursorFastParameter";
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Dollars per million tokens. https://cursor.com/docs/models-and-pricing (2026-11-28).
// A dash in the cache-write column is 0. Requests send fast=false, so the
// fast price rows stay unused. grok-4.7 is the 500k row because that is the
// context value this provider sends. Third-party models use their API list
// price, which Cursor bills from prepaid credit.
const CATALOG_COST: Readonly<Record<string, typeof ZERO_COST>> = {
	"composer-2.5": { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
	"deepseek-v41-flash-1017": { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
	"glm-5.2": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"glm-5p3": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
	"glm-5p3-flash": { input: 0.15, output: 0.5, cacheRead: 0.029, cacheWrite: 0 },
	"grok-4.5": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
	"grok-4.6": { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
	"grok-4.7": { input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
	"kimi-k2.7-code": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-k3": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
};

const CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
	"composer-2.5": 200_000,
	"deepseek-v41-flash-1017": 1_048_576,
	default: 200_000,
	"glm-5.2": 200_000,
	"glm-5p3": 1_000_000,
	"glm-5p3-flash": 1_000_000,
	"grok-4.5": 256_000,
	"grok-4.6": 256_000,
	"grok-4.7": 500_000,
	"kimi-k2.7-code": 262_144,
	"kimi-k3": 1_048_576,
};

type CursorCatalogModel = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	samplingParams?: Record<string, unknown>;
	input: ["text", "image"];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

function catalogModel(id: string, name: string): CursorCatalogModel {
	return {
		id,
		name,
		reasoning: false,
		input: ["text", "image"],
		cost: { ...(CATALOG_COST[id] ?? ZERO_COST) },
		contextWindow: CONTEXT_WINDOWS[id] ?? FALLBACK_CONTEXT_WINDOW,
		maxTokens: FALLBACK_MAX_TOKENS,
	};
}

export function fallbackCursorModel(): ProviderModelConfig {
	return catalogModel(FALLBACK_CURSOR_MODEL_ID, "Grok 4.6");
}

function isPiThinkingLevel(value: string): value is PiThinkingLevel {
	return (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

function parameterValues(parameter: ModelParameterDefinition): Set<string> {
	const values = new Set<string>();
	for (const entry of parameter.values) {
		if (entry.value.length > 0) values.add(entry.value);
	}
	return values;
}

function contextTokens(value: string): number | undefined {
	const match = /^(\d+)(k|m)$/i.exec(value.trim());
	if (!match || match[1] === undefined || match[2] === undefined) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	return amount * (match[2].toLowerCase() === "m" ? 1_000_000 : 1_000);
}

function contextParameter(item: ModelListItem, contextWindow: number): { id: string; value: string } | undefined {
	const parameter = item.parameters?.find((candidate) => candidate.id === "context");
	if (!parameter) return undefined;
	for (const entry of parameter.values) {
		if (contextTokens(entry.value) === contextWindow) return { id: parameter.id, value: entry.value };
	}
	return undefined;
}

function fastParameterId(item: ModelListItem): string | undefined {
	const parameter = item.parameters?.find((candidate) => candidate.id === "fast");
	if (!parameter || !parameterValues(parameter).has("false")) return undefined;
	return parameter.id;
}

function thinkingParameter(item: ModelListItem): { id: string; values: Set<string> } | undefined {
	for (const id of THINKING_PARAMETER_IDS) {
		const parameter = item.parameters?.find((candidate) => candidate.id === id);
		if (!parameter) continue;
		const values = parameterValues(parameter);
		if (values.size > 0) return { id, values };
	}
	return undefined;
}

function thinkingLevelMap(values: Set<string>): ThinkingLevelMap | undefined {
	const off = values.has("off") ? "off" : values.has("none") ? "none" : values.has("false") ? "false" : null;
	const map: ThinkingLevelMap = {
		off,
		minimal: values.has("minimal") ? "minimal" : null,
		low: values.has("low") ? "low" : null,
		medium: values.has("medium") ? "medium" : null,
		high: values.has("high") ? "high" : null,
		xhigh: values.has("xhigh") ? "xhigh" : null,
		max: values.has("max") ? "max" : null,
	};
	return Object.values(map).some((value) => typeof value === "string") ? map : undefined;
}

export function cursorModelFromListItem(item: ModelListItem): ProviderModelConfig {
	const base = catalogModel(item.id, item.displayName || item.id);
	const samplingParams: Record<string, unknown> = {};
	const context = contextParameter(item, base.contextWindow);
	if (context) {
		samplingParams[CONTEXT_PARAMETER_KEY] = context.id;
		samplingParams[CONTEXT_VALUE_KEY] = context.value;
	}
	const fastId = fastParameterId(item);
	if (fastId) samplingParams[FAST_PARAMETER_KEY] = fastId;
	const parameter = thinkingParameter(item);
	const map = parameter ? thinkingLevelMap(parameter.values) : undefined;
	if (parameter && map) {
		samplingParams[THINKING_PARAMETER_KEY] = parameter.id;
		return {
			...base,
			reasoning: true,
			thinkingLevelMap: map,
			samplingParams,
		};
	}
	if (Object.keys(samplingParams).length === 0) return base;
	return { ...base, samplingParams };
}

export function cursorModelSelection(
	model: { id: string; thinkingLevelMap?: ThinkingLevelMap; samplingParams?: Record<string, unknown> },
	reasoning: string | undefined,
): ModelSelection {
	const params: { id: string; value: string }[] = [];
	const contextId = model.samplingParams?.[CONTEXT_PARAMETER_KEY];
	const contextValue = model.samplingParams?.[CONTEXT_VALUE_KEY];
	if (typeof contextId === "string" && contextId.length > 0 && typeof contextValue === "string" && contextValue.length > 0) {
		params.push({ id: contextId, value: contextValue });
	}
	const parameterId = model.samplingParams?.[THINKING_PARAMETER_KEY];
	const level: PiThinkingLevel = reasoning !== undefined && isPiThinkingLevel(reasoning) ? reasoning : "off";
	const value = model.thinkingLevelMap?.[level];
	if (typeof parameterId === "string" && parameterId.length > 0 && typeof value === "string") {
		params.push({ id: parameterId, value });
	}
	const fastId = model.samplingParams?.[FAST_PARAMETER_KEY];
	if (typeof fastId === "string" && fastId.length > 0) {
		params.push({ id: fastId, value: "false" });
	}
	if (params.length === 0) return { id: model.id };
	return { id: model.id, params };
}

export function rememberedCursorModels(apiKey: string | undefined, cacheDir: string): ProviderModelConfig[] {
	if (!apiKey) return [fallbackCursorModel()];
	const cached = readCachedCursorModels(apiKey, cacheDir);
	if (!cached) return [fallbackCursorModel()];
	return cached.map((item) => cursorModelFromListItem(item));
}

export async function loadCursorModels(
	apiKey: string | undefined,
	rememberTo?: string,
): Promise<ProviderModelConfig[]> {
	if (!apiKey) return [fallbackCursorModel()];
	try {
		const models = await Cursor.models.list({ apiKey });
		if (models.length === 0) return [fallbackCursorModel()];
		if (rememberTo) writeCachedCursorModels(apiKey, models, rememberTo);
		return models.map((item) => cursorModelFromListItem(item));
	} catch {
		if (rememberTo) {
			const cached = readCachedCursorModels(apiKey, rememberTo);
			if (cached) return cached.map((item) => cursorModelFromListItem(item));
		}
		return [fallbackCursorModel()];
	}
}
