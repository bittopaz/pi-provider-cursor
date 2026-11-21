import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { resolveCursorApiKey } from "./cursor-api-key.js";
import { resetCursorSession, runCursorTurn, setCursorToolSource } from "./cursor-session.js";

const MISSING_KEY = "Cursor needs an API key from CURSOR_API_KEY or /login.";

export { resetCursorSession, setCursorToolSource };

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function emptyMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function scrubCursorText(text: string, apiKey: string | undefined): string {
	const key = apiKey?.trim();
	const withoutKey = key ? text.split(key).join("[redacted]") : text;
	return withoutKey.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

export function streamCursor(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial = emptyMessage(model);
	const apiKey = resolveCursorApiKey(options?.apiKey);
	if (!apiKey) {
		partial.stopReason = "error";
		partial.errorMessage = MISSING_KEY;
		stream.push({ type: "error", reason: "error", error: partial });
		return stream;
	}
	void runCursorTurn({
		stream,
		partial,
		model,
		messages: context.messages,
		options,
		apiKey,
		scrub: (text) => scrubCursorText(text, apiKey),
	}).catch((error) => {
		if (partial.stopReason !== "stop" && partial.stopReason !== "pending") return;
		partial.stopReason = "error";
		partial.errorMessage = scrubCursorText(error instanceof Error ? error.message : String(error), apiKey);
		stream.push({ type: "error", reason: "error", error: partial });
	});
	return stream;
}
