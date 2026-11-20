import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, emptyFs, JsonlLocalAgentStore, type InteractionUpdate, type Run, type RunResult, type SDKAgent, type TokenUsage } from "@cursor/sdk";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { resolveCursorApiKey } from "./cursor-api-key.js";
import { withMutedSdkOutput } from "./cursor-output.js";
import { buildCursorPrompt } from "./cursor-prompt.js";

const MISSING_KEY = "Cursor needs an API key from CURSOR_API_KEY or /login.";

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

function errorText(error: unknown, apiKey: string | undefined): string {
	const message = error instanceof Error ? error.message : String(error);
	return scrubCursorText(message, apiKey);
}

function applyTokenUsage(usage: Usage, tokens: TokenUsage | undefined): void {
	if (!tokens) return;
	usage.input = tokens.inputTokens;
	usage.output = tokens.outputTokens;
	usage.cacheRead = tokens.cacheReadTokens;
	usage.cacheWrite = tokens.cacheWriteTokens;
	usage.totalTokens = tokens.totalTokens;
	if (tokens.reasoningTokens !== undefined) usage.reasoning = tokens.reasoningTokens;
}

function promptTextFromPayload(payload: unknown, fallback: string): string {
	if (payload === undefined) return fallback;
	if (typeof payload === "string") return payload;
	if (typeof payload === "object" && payload !== null && "text" in payload && typeof payload.text === "string") {
		return payload.text;
	}
	return fallback;
}

export function streamCursor(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial = emptyMessage(model);
	const apiKey = resolveCursorApiKey(options?.apiKey);
	void runTurn(stream, partial, model, context, options, apiKey);
	return stream;
}

async function runTurn(
	stream: AssistantMessageEventStream,
	partial: AssistantMessage,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	apiKey: string | undefined,
): Promise<void> {
	let settled = false;
	let run: Run | undefined;
	let blocks: OpenBlocks | undefined;
	const resources: { agent?: SDKAgent; storeDir?: string } = {};
	const onAbort = () => {
		void Promise.resolve()
			.then(() => run?.cancel())
			.catch(() => undefined);
	};
	const finish = async (stopReason: Extract<StopReason, "stop" | "aborted" | "error">, errorMessage?: string) => {
		if (settled) return;
		settled = true;
		options?.signal?.removeEventListener("abort", onAbort);
		await resources.agent?.[Symbol.asyncDispose]().catch(() => undefined);
		if (resources.storeDir) await rm(resources.storeDir, { recursive: true, force: true }).catch(() => undefined);
		partial.stopReason = stopReason;
		if (errorMessage !== undefined) partial.errorMessage = errorMessage;
		if (stopReason === "stop") {
			blocks?.close();
			stream.push({ type: "done", reason: "stop", message: partial });
			return;
		}
		stream.push({ type: "error", reason: stopReason, error: partial });
	};

	if (!apiKey) {
		await finish("error", MISSING_KEY);
		return;
	}

	blocks = new OpenBlocks(stream, partial);
	options?.signal?.addEventListener("abort", onAbort);

	try {
		if (options?.signal?.aborted) {
			await finish("aborted", "Cursor request was aborted.");
			return;
		}

		const prompt = buildCursorPrompt(context.messages);
		const replaced = await options?.onPayload?.({ text: prompt }, model);
		const text = promptTextFromPayload(replaced, prompt);
		let streamedText = false;

		const applyUpdate = (update: InteractionUpdate) => {
			void options?.onProviderStreamEvent?.(update, model);
			if (update.type === "text-delta") {
				if (update.text.length > 0) streamedText = true;
				blocks?.appendText(update.text);
				return;
			}
			if (update.type === "thinking-delta") blocks?.appendThinking(update.text);
		};

		stream.push({ type: "start", partial });
		const storeDir = await mkdtemp(join(tmpdir(), "pi-cursor-"));
		resources.storeDir = storeDir;
		const created = await withMutedSdkOutput(() => Agent.create({
			apiKey,
			model: { id: model.id },
			tools: [],
			local: { cwd: process.cwd(), fs: emptyFs(), store: new JsonlLocalAgentStore(storeDir) },
		}));
		resources.agent = created;
		if (options?.signal?.aborted) {
			await finish("aborted", "Cursor request was aborted.");
			return;
		}

		const sent = await withMutedSdkOutput(() => created.send(text, {
			model: { id: model.id },
			onDelta: ({ update }) => {
				applyUpdate(update);
			},
		}));
		run = sent;
		if (options?.signal?.aborted) {
			await sent.cancel().catch(() => undefined);
			await finish("aborted", "Cursor request was aborted.");
			return;
		}

		await options?.onResponse?.({ status: 200, headers: {} }, model);
		const result = await withMutedSdkOutput(() => sent.wait());
		applyTokenUsage(partial.usage, result.usage);
		if (!streamedText && result.result) blocks.appendText(result.result);
		const billed = await withMutedSdkOutput(() => created.getUsage()).catch(() => undefined);
		applyTokenUsage(partial.usage, billed?.usage ?? result.usage);
		if (billed?.cost) {
			partial.usage.cost.total = billed.cost.chargedCents / 100;
			partial.usage.cost.totalFromProvider = true;
		}
		await finish(stopReasonFor(result), result.status === "error"
			? scrubCursorText(result.error?.message || "Cursor run failed.", apiKey)
			: undefined);
	} catch (error) {
		if (options?.signal?.aborted) {
			await finish("aborted", "Cursor request was aborted.");
			return;
		}
		await finish("error", errorText(error, apiKey));
	}
}

function stopReasonFor(result: RunResult): Extract<StopReason, "stop" | "aborted" | "error"> {
	switch (result.status) {
		case "finished":
			return "stop";
		case "cancelled":
			return "aborted";
		case "error":
			return "error";
		default: {
			const unreachable: never = result.status;
			return unreachable;
		}
	}
}

class OpenBlocks {
	private textOpen = false;
	private thinkingOpen = false;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		private readonly partial: AssistantMessage,
	) {}

	appendText(delta: string): void {
		if (!delta) return;
		this.closeThinking();
		if (!this.textOpen) {
			this.partial.content.push({ type: "text", text: "" });
			this.stream.push({ type: "text_start", contentIndex: this.partial.content.length - 1, partial: this.partial });
			this.textOpen = true;
		}
		const block = this.partial.content.at(-1);
		if (block?.type !== "text") return;
		block.text += delta;
		this.stream.push({ type: "text_delta", contentIndex: this.partial.content.length - 1, delta, partial: this.partial });
	}

	appendThinking(delta: string): void {
		if (!delta) return;
		this.closeText();
		if (!this.thinkingOpen) {
			this.partial.content.push({ type: "thinking", thinking: "" });
			this.stream.push({ type: "thinking_start", contentIndex: this.partial.content.length - 1, partial: this.partial });
			this.thinkingOpen = true;
		}
		const block = this.partial.content.at(-1);
		if (block?.type !== "thinking") return;
		block.thinking += delta;
		this.stream.push({ type: "thinking_delta", contentIndex: this.partial.content.length - 1, delta, partial: this.partial });
	}

	close(): void {
		this.closeText();
		this.closeThinking();
	}

	private closeText(): void {
		if (!this.textOpen) return;
		this.textOpen = false;
		const index = this.partial.content.length - 1;
		const block = this.partial.content[index];
		if (block?.type !== "text") return;
		this.stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: this.partial });
	}

	private closeThinking(): void {
		if (!this.thinkingOpen) return;
		this.thinkingOpen = false;
		const index = this.partial.content.length - 1;
		const block = this.partial.content[index];
		if (block?.type !== "thinking") return;
		this.stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: this.partial });
	}
}
