const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";
const CURSOR_API_KEY_PLACEHOLDER_SUFFIX = "-cursor-api-key-placeholder";

const PLACEHOLDERS = new Set([
	CURSOR_API_KEY_ENV_VAR,
	`$${CURSOR_API_KEY_ENV_VAR}`,
	`\${${CURSOR_API_KEY_ENV_VAR}}`,
]);

export function normalizeCursorApiKey(apiKey: string | undefined): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed || PLACEHOLDERS.has(trimmed) || trimmed.endsWith(CURSOR_API_KEY_PLACEHOLDER_SUFFIX)) return undefined;
	return trimmed;
}

export function resolveCursorApiKey(apiKey: string | undefined): string | undefined {
	return normalizeCursorApiKey(apiKey) ?? normalizeCursorApiKey(process.env.CURSOR_API_KEY);
}
