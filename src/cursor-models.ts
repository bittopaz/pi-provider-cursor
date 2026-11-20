import { Cursor, type ModelListItem } from "@cursor/sdk";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const FALLBACK_CURSOR_MODEL_ID = "grok-4.6";

const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function catalogModel(id: string, name: string): ProviderModelConfig {
	return {
		id,
		name,
		reasoning: false,
		input: ["text"],
		cost: { ...ZERO_COST },
		contextWindow: FALLBACK_CONTEXT_WINDOW,
		maxTokens: FALLBACK_MAX_TOKENS,
	};
}

export function fallbackCursorModel(): ProviderModelConfig {
	return catalogModel(FALLBACK_CURSOR_MODEL_ID, "Grok 4.6");
}

export function cursorModelFromListItem(item: ModelListItem): ProviderModelConfig {
	return catalogModel(item.id, item.displayName || item.id);
}

export async function loadCursorModels(apiKey: string | undefined): Promise<ProviderModelConfig[]> {
	if (!apiKey) return [fallbackCursorModel()];
	try {
		const models = await Cursor.models.list({ apiKey });
		if (models.length === 0) return [fallbackCursorModel()];
		return models.map((item) => cursorModelFromListItem(item));
	} catch {
		return [fallbackCursorModel()];
	}
}
