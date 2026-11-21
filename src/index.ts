import type { SDKJsonValue } from "@cursor/sdk";
import { getAgentDir, type ExtensionAPI, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { normalizeCursorApiKey } from "./cursor-api-key.js";
import { fallbackCursorModel, loadCursorModels, rememberedCursorModels } from "./cursor-models.js";
import { resetCursorSession, setCursorToolSource, streamCursor } from "./cursor-provider.js";
import type { CursorToolSpec } from "./cursor-session.js";

function plainSchema(parameters: unknown): Record<string, SDKJsonValue> | undefined {
	try {
		const value = JSON.parse(JSON.stringify(parameters)) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, SDKJsonValue>;
	} catch {
		return undefined;
	}
	return undefined;
}

type ToolSpecInput = Pick<ToolInfo, "name" | "description"> & { parameters: unknown };

export function cursorToolSpecs(tools: readonly ToolSpecInput[], activeNames: readonly string[]): CursorToolSpec[] {
	const active = new Set(activeNames);
	return tools.flatMap((tool) => {
		if (!active.has(tool.name)) return [];
		const inputSchema = plainSchema(tool.parameters);
		return [{ name: tool.name, description: tool.description, ...(inputSchema ? { inputSchema } : {}) }];
	});
}

export default function (pi: ExtensionAPI) {
	setCursorToolSource(() => cursorToolSpecs(pi.getAllTools(), pi.getActiveTools()));
	pi.on("session_shutdown", () => {
		void resetCursorSession();
	});
	pi.registerProvider("cursor", {
		name: "Cursor",
		baseUrl: "https://cursor.com",
		api: "cursor-sdk",
		apiKey: "$CURSOR_API_KEY",
		models: [fallbackCursorModel()],
		streamSimple: streamCursor,
		async refreshModels(context) {
			context.signal.throwIfAborted();
			const credential = context.credential;
			const apiKey = credential?.type === "api_key"
				? normalizeCursorApiKey(credential.key) ?? normalizeCursorApiKey(credential.env?.CURSOR_API_KEY)
				: undefined;
			const cacheDir = getAgentDir();
			if (!context.allowNetwork) return rememberedCursorModels(apiKey, cacheDir);
			return loadCursorModels(apiKey, cacheDir);
		},
	});
}
