const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";

const PLACEHOLDERS = new Set([
	CURSOR_API_KEY_ENV_VAR,
	`$${CURSOR_API_KEY_ENV_VAR}`,
	`\${${CURSOR_API_KEY_ENV_VAR}}`,
	"pi-cursor-sdk-cursor-api-key-placeholder",
]);

export function normalizeCursorApiKey(apiKey: string | undefined): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed || PLACEHOLDERS.has(trimmed)) return undefined;
	return trimmed;
}

export function resolveCursorApiKey(apiKey: string | undefined): string | undefined {
	return normalizeCursorApiKey(apiKey) ?? normalizeCursorApiKey(process.env.CURSOR_API_KEY);
}
