import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeCursorApiKey } from "./cursor-api-key.js";
import { fallbackCursorModel, loadCursorModels } from "./cursor-models.js";
import { streamCursor } from "./cursor-provider.js";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("cursor", {
		name: "Cursor",
		baseUrl: "https://cursor.com",
		api: "cursor-sdk",
		apiKey: "$CURSOR_API_KEY",
		models: [fallbackCursorModel()],
		streamSimple: streamCursor,
		async refreshModels(context) {
			context.signal.throwIfAborted();
			if (!context.allowNetwork) return [fallbackCursorModel()];
			const credential = context.credential;
			const apiKey = credential?.type === "api_key"
				? normalizeCursorApiKey(credential.key) ?? normalizeCursorApiKey(credential.env?.CURSOR_API_KEY)
				: undefined;
			return loadCursorModels(apiKey);
		},
	});
}
