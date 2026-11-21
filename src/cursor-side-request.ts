import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, emptyFs, JsonlLocalAgentStore, type ModelSelection, type SDKAgent } from "@cursor/sdk";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { normalizeCursorApiKey, resolveCursorApiKey } from "./cursor-api-key.js";
import { cursorModelSelection } from "./cursor-models.js";
import { withMutedSdkOutput } from "./cursor-output.js";
import { scrubCursorText } from "./cursor-provider.js";

const MISSING_KEY = "Cursor needs an API key from CURSOR_API_KEY or /login.";

export interface CursorSideModel {
	id: string;
	thinkingLevelMap?: ThinkingLevelMap;
	samplingParams?: Record<string, unknown>;
}

export interface CursorSideRequest {
	model: CursorSideModel;
	prompt: string;
	systemPrompt?: string;
	signal?: AbortSignal;
	maxTokens?: number;
	reasoning?: string;
}

export interface CursorSideResult {
	text: string;
	stopReason: string;
	errorMessage?: string;
}

function cursorApiKey(): string | undefined {
	const stored = readStoredCredential("cursor");
	const storedKey = stored?.type === "api_key"
		? normalizeCursorApiKey(stored.key) ?? normalizeCursorApiKey(stored.env?.CURSOR_API_KEY)
		: undefined;
	return storedKey ?? resolveCursorApiKey(undefined);
}

export async function completeCursorSideRequest(request: CursorSideRequest): Promise<CursorSideResult> {
	if (request.signal?.aborted) return { text: "", stopReason: "aborted" };
	const apiKey = cursorApiKey();
	if (!apiKey) return { text: "", stopReason: "error", errorMessage: MISSING_KEY };

	const selection = cursorModelSelection(request.model, request.reasoning);
	const storeDir = await mkdtemp(join(tmpdir(), "pi-cursor-side-"));
	let agent: SDKAgent | undefined;
	try {
		agent = await openAgent(apiKey, selection, request.systemPrompt, storeDir);
		if (request.signal?.aborted) return { text: "", stopReason: "aborted" };
		return await ask(agent, request, selection, apiKey);
	} catch (error) {
		if (request.signal?.aborted) return { text: "", stopReason: "aborted" };
		const message = error instanceof Error ? error.message : String(error);
		return { text: "", stopReason: "error", errorMessage: scrubCursorText(message, apiKey) };
	} finally {
		await agent?.[Symbol.asyncDispose]().catch(() => undefined);
		await rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function openAgent(
	apiKey: string,
	selection: ModelSelection,
	systemPrompt: string | undefined,
	storeDir: string,
): Promise<SDKAgent> {
	const prompt = systemPrompt?.trim();
	return withMutedSdkOutput(() => Agent.create({
		apiKey,
		model: selection,
		tools: [],
		...(prompt ? { systemPrompt: prompt } : {}),
		local: {
			cwd: process.cwd(),
			fs: emptyFs(),
			store: new JsonlLocalAgentStore(storeDir),
			settingSources: [],
		},
	}));
}

async function ask(
	agent: SDKAgent,
	request: CursorSideRequest,
	selection: ModelSelection,
	apiKey: string,
): Promise<CursorSideResult> {
	let heard = "";
	const run = await withMutedSdkOutput(() => agent.send(request.prompt, {
		model: selection,
		onDelta: ({ update }) => {
			if (update.type === "text-delta" && update.text) heard += update.text;
		},
	}));
	const onAbort = () => {
		void run.cancel().catch(() => undefined);
	};
	request.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const result = await withMutedSdkOutput(() => run.wait());
		if (request.signal?.aborted || result.status === "cancelled") return { text: "", stopReason: "aborted" };
		if (result.status !== "finished") {
			const message = result.error?.message || "Cursor run failed.";
			return { text: "", stopReason: "error", errorMessage: scrubCursorText(message, apiKey) };
		}
		return { text: heard || result.result || "", stopReason: "stop" };
	} finally {
		request.signal?.removeEventListener("abort", onAbort);
	}
}
