import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	emptyFs,
	JsonlLocalAgentStore,
	type InteractionUpdate,
	type ModelSelection,
	type Run,
	type RunResult,
	type SDKAgent,
	type SDKCustomTool,
	type SDKCustomToolContent,
	type SDKCustomToolResult,
	type SDKJsonValue,
	type SDKUserMessage,
} from "@cursor/sdk";
import {
	getCurrentSystemPrompt,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { cursorModelSelection } from "./cursor-models.js";
import { withMutedSdkOutput } from "./cursor-output.js";
import { buildCursorPrompt, cursorPendingUserText, cursorPromptImages } from "./cursor-prompt.js";

const ABORTED = "Cursor request was aborted.";

export type CursorToolSpec = {
	name: string;
	description: string;
	inputSchema?: Record<string, SDKJsonValue>;
};

type Sink = {
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	blocks: OpenBlocks;
	closed: boolean;
	sawText: boolean;
};

type Park = {
	id: string;
	name: string;
	args: Record<string, SDKJsonValue>;
	emitted: boolean;
	settled: boolean;
	clear: () => void;
	resolve: (result: SDKCustomToolResult) => void;
	reject: (error: Error) => void;
};

type Live = {
	agent: SDKAgent;
	storeDir: string;
	key: string;
	system: string;
	delivered: number;
	run?: Run;
};

export type CursorTurn = {
	stream: AssistantMessageEventStream;
	partial: AssistantMessage;
	model: Model<Api>;
	messages: readonly Message[];
	options: SimpleStreamOptions | undefined;
	apiKey: string;
	scrub: (text: string) => string;
};

let toolSource: () => CursorToolSpec[] = () => [];
let live: Live | undefined;
let sink: Sink | undefined;
let driveToken = 0;
let flushQueued = false;
let unwatch: (() => void) | undefined;
let disposing: Promise<void> | undefined;
let latestModelCall: ModelCallTokens | undefined;
let chargedCentsApplied = 0;

type ModelCallTokens = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens?: number;
};
const parks = new Map<string, Park>();
const held = { text: "", thinking: "" };

export function setCursorToolSource(source: () => CursorToolSpec[]): void {
	toolSource = source;
}

export async function resetCursorSession(): Promise<void> {
	rejectParks("Cursor agent was replaced.");
	await dispose();
}

export async function runCursorTurn(turn: CursorTurn): Promise<void> {
	const signal = turn.options?.signal;
	try {
		if (signal?.aborted) {
			await failAborted(turn);
			return;
		}

		const specs = toolSource();
		const selection = cursorModelSelection(turn.model, turn.options?.reasoning);
		const system = getCurrentSystemPrompt(turn.messages).trim();
		const key = JSON.stringify({ selection, mcp: specs.length > 0, apiKey: turn.apiKey });
		const matched = matchingResults(turn.messages);

		if (parks.size > 0 && matched.length > 0 && !signal?.aborted) {
			const current = openSink(turn);
			watch(signal);
			await turn.options?.onResponse?.({ status: 200, headers: {} }, turn.model);
			for (const message of matched) resolvePark(message);
			if (live) live.delivered = turn.messages.length;
			return;
		}

		if (parks.size > 0) {
			rejectParks(signal?.aborted ? ABORTED : "Cursor tool call was abandoned.");
			await dispose();
			if (signal?.aborted) {
				await failAborted(turn);
				return;
			}
		}

		const reuse = live !== undefined && live.key === key && live.system === system;
		if (!reuse) {
			await dispose();
			live = await createLive(turn.apiKey, selection, specs.length > 0, key, system);
		}
		const agent = live;
		if (!agent) return;

		const pending = turn.messages.slice(agent.delivered);
		const prompt = reuse ? cursorPendingUserText(pending) : buildCursorPrompt(turn.messages);
		if (reuse && prompt.trim() === "") {
			fail(turn, "Cursor has no new user text.");
			return;
		}

		const replaced = await turn.options?.onPayload?.({ text: prompt }, turn.model);
		const text = promptText(replaced, prompt);
		const imageSource = reuse ? pending.filter((message) => message.role === "user") : turn.messages;
		const images = cursorPromptImages(imageSource);
		const message: string | SDKUserMessage = images.length > 0 ? { text, images } : text;
		const current = openSink(turn);
		watch(signal);
		latestModelCall = undefined;
		const sent = await withMutedSdkOutput(() => agent.agent.send(message, {
			model: selection,
			onDelta: ({ update }) => applyUpdate(update, turn),
			...(specs.length > 0 ? { local: { customTools: customTools(specs, signal) } } : {}),
		}));
		agent.run = sent;
		agent.delivered = turn.messages.length;
		if (signal?.aborted) {
			await sent.cancel().catch(() => undefined);
			finishAborted(current);
			await dispose();
			return;
		}
		await turn.options?.onResponse?.({ status: 200, headers: {} }, turn.model);
		startDrive(sent, driveToken, turn);
	} catch (error) {
		if (turn.options?.signal?.aborted) {
			await failAborted(turn);
			return;
		}
		fail(turn, errorText(error, turn.scrub));
		await dispose();
	}
}

function customTools(specs: readonly CursorToolSpec[], signal: AbortSignal | undefined): Record<string, SDKCustomTool> {
	const tools: Record<string, SDKCustomTool> = {};
	for (const spec of specs) {
		tools[spec.name] = {
			description: spec.description,
			...(spec.inputSchema ? { inputSchema: spec.inputSchema } : {}),
			execute: (args, context) => {
				const promise = new Promise<SDKCustomToolResult>((resolve, reject) => {
					const id = context.toolCallId ?? randomUUID();
					const previous = parks.get(id);
					if (previous && settle(previous)) previous.reject(new Error("Cursor tool call was replaced."));
					const park: Park = {
						id,
						name: spec.name,
						args,
						emitted: false,
						settled: false,
						clear: () => undefined,
						resolve,
						reject,
					};
					const onAbort = () => {
						if (!settle(park)) return;
						park.reject(new Error("Operation aborted"));
						void live?.run?.cancel().catch(() => undefined);
					};
					park.clear = () => signal?.removeEventListener("abort", onAbort);
					parks.set(id, park);
					if (signal?.aborted) onAbort();
					else signal?.addEventListener("abort", onAbort, { once: true });
					scheduleFlush();
				});
				promise.catch(() => undefined);
				return promise;
			},
		};
	}
	return tools;
}

function matchingResults(messages: readonly Message[]): ToolResultMessage[] {
	const results: ToolResultMessage[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		if (!parks.has(message.toolCallId)) continue;
		results.push(message);
	}
	return results;
}

function resolvePark(message: ToolResultMessage): void {
	const park = parks.get(message.toolCallId);
	if (!park || !settle(park)) return;
	park.resolve(sdkResult(message));
}

function sdkResult(message: ToolResultMessage): SDKCustomToolResult {
	const blocks: SDKCustomToolContent[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text.length > 0) blocks.push({ type: "text", text: block.text });
		if (block.type === "image" && block.data.length > 0) {
			blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
		}
	}
	if (message.isError) {
		return { content: blocks.length > 0 ? blocks : [{ type: "text", text: "Tool failed." }], isError: true };
	}
	const only = blocks[0];
	if (blocks.length === 1 && only?.type === "text") return only.text;
	if (blocks.length === 0) return "";
	return { content: blocks };
}

function rejectParks(message: string): void {
	for (const park of [...parks.values()]) {
		if (!settle(park)) continue;
		park.reject(new Error(message));
	}
}

function settle(park: Park): boolean {
	if (park.settled) return false;
	park.settled = true;
	park.clear();
	parks.delete(park.id);
	return true;
}

function scheduleFlush(): void {
	if (flushQueued) return;
	flushQueued = true;
	queueMicrotask(() => {
		flushQueued = false;
		const current = sink;
		if (!current || current.closed) return;
		// The Pi stream closes on toolUse while wait() stays open. The next provider call resolves these parks.
		const fresh = [...parks.values()].filter((park) => !park.emitted);
		if (fresh.length === 0) return;
		current.blocks.close();
		for (const park of fresh) {
			park.emitted = true;
			const call: ToolCall = {
				type: "toolCall",
				id: park.id,
				name: park.name,
				arguments: piArguments(park.name, park.args),
			};
			current.partial.content.push(call);
			const index = current.partial.content.length - 1;
			current.stream.push({ type: "toolcall_start", contentIndex: index, partial: current.partial });
			current.stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: current.partial });
		}
		current.partial.stopReason = "toolUse";
		closeSink(current);
		current.stream.push({ type: "done", reason: "toolUse", message: current.partial });
	});
}

const PATH_ARGUMENT_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function piArguments(name: string, args: Record<string, SDKJsonValue>): JsonObject {
	const parsed = JSON.parse(JSON.stringify(args)) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const record = parsed as JsonObject;
	if (!PATH_ARGUMENT_TOOLS.has(name) || typeof record.file_path !== "string") return record;
	const { file_path: filePath, ...rest } = record;
	if (typeof rest.path === "string") return rest;
	return { ...rest, path: filePath };
}

function openSink(turn: CursorTurn): Sink {
	turn.stream.push({ type: "start", partial: turn.partial });
	const current: Sink = {
		stream: turn.stream,
		partial: turn.partial,
		blocks: new OpenBlocks(turn.stream, turn.partial),
		closed: false,
		sawText: false,
	};
	sink = current;
	if (held.thinking) {
		current.blocks.appendThinking(held.thinking);
		held.thinking = "";
	}
	if (held.text) {
		current.blocks.appendText(held.text);
		current.sawText = true;
		held.text = "";
	}
	scheduleFlush();
	return current;
}

function closeSink(current: Sink): void {
	current.closed = true;
	if (sink === current) sink = undefined;
}

function watch(signal: AbortSignal | undefined): void {
	unwatch?.();
	unwatch = undefined;
	if (!signal) return;
	const onAbort = () => {
		rejectParks("Operation aborted");
		void live?.run?.cancel().catch(() => undefined);
		const current = sink;
		if (current && !current.closed) finishAborted(current);
	};
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort);
	unwatch = () => signal.removeEventListener("abort", onAbort);
}

function applyUpdate(update: InteractionUpdate, turn: CursorTurn): void {
	void turn.options?.onProviderStreamEvent?.(update, turn.model);
	if (update.type === "model-call-completed") {
		latestModelCall = update.usage;
		return;
	}
	if (update.type === "text-delta") {
		if (!update.text) return;
		const current = sink;
		if (!current || current.closed) {
			held.text += update.text;
			return;
		}
		current.blocks.appendText(update.text);
		current.sawText = true;
		return;
	}
	if (update.type === "thinking-delta") {
		if (!update.text) return;
		const current = sink;
		if (!current || current.closed) {
			held.thinking += update.text;
			return;
		}
		current.blocks.appendThinking(update.text);
	}
}

function startDrive(run: Run, token: number, turn: CursorTurn): void {
	void (async () => {
		try {
			const result = await withMutedSdkOutput(() => run.wait());
			if (token !== driveToken) return;
			const current = sink;
			if (result.status !== "finished") {
				if (current && !current.closed) {
					if (result.status === "cancelled") finishAborted(current);
					else finishError(current, turn.scrub(result.error?.message || "Cursor run failed."));
				}
				await dispose();
				return;
			}
			if (!current || current.closed) return;
			applyModelCall(current.partial.usage, latestModelCall);
			latestModelCall = undefined;
			const billed = await withMutedSdkOutput(() => live?.agent.getUsage() ?? Promise.resolve(undefined)).catch(() => undefined);
			if (token !== driveToken || current.closed) return;
			if (billed?.cost) {
				const charged = billed.cost.chargedCents;
				const delta = Math.max(0, charged - chargedCentsApplied);
				chargedCentsApplied = charged;
				current.partial.usage.cost.total = delta / 100;
				current.partial.usage.cost.totalFromProvider = true;
			}
			if (!current.sawText && result.result) {
				current.blocks.appendText(result.result);
				current.sawText = true;
			}
			current.blocks.close();
			current.partial.stopReason = "stop";
			closeSink(current);
			unwatch?.();
			unwatch = undefined;
			current.stream.push({ type: "done", reason: "stop", message: current.partial });
		} catch (error) {
			if (token !== driveToken) return;
			const current = sink;
			if (current && !current.closed) finishError(current, errorText(error, turn.scrub));
			await dispose();
		}
	})();
}

async function createLive(
	apiKey: string,
	selection: ModelSelection,
	mcp: boolean,
	key: string,
	system: string,
): Promise<Live> {
	const storeDir = await mkdtemp(join(tmpdir(), "pi-cursor-"));
	try {
		const agent = await withMutedSdkOutput(() => Agent.create({
			apiKey,
			model: selection,
			tools: mcp ? ["mcp"] : [],
			local: {
				cwd: process.cwd(),
				fs: emptyFs(),
				store: new JsonlLocalAgentStore(storeDir),
				settingSources: [],
			},
		}));
		return { agent, storeDir, key, system, delivered: 0 };
	} catch (error) {
		await rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}

async function dispose(): Promise<void> {
	if (disposing) return disposing;
	const current = live;
	live = undefined;
	held.text = "";
	held.thinking = "";
	latestModelCall = undefined;
	chargedCentsApplied = 0;
	driveToken += 1;
	unwatch?.();
	unwatch = undefined;
	if (!current) return;
	disposing = (async () => {
		await current.run?.cancel().catch(() => undefined);
		await current.agent[Symbol.asyncDispose]().catch(() => undefined);
		await rm(current.storeDir, { recursive: true, force: true }).catch(() => undefined);
	})().finally(() => {
		disposing = undefined;
	});
	return disposing;
}

async function failAborted(turn: CursorTurn): Promise<void> {
	rejectParks("Operation aborted");
	await dispose();
	const current = sink;
	if (current && !current.closed) {
		finishAborted(current);
		return;
	}
	if (!turn.partial.stopReason || turn.partial.stopReason === "stop") {
		turn.partial.stopReason = "aborted";
		turn.partial.errorMessage = ABORTED;
		turn.stream.push({ type: "error", reason: "aborted", error: turn.partial });
	}
}

function fail(turn: CursorTurn, message: string): void {
	const current = sink;
	if (current && !current.closed) {
		finishError(current, message);
		return;
	}
	turn.partial.stopReason = "error";
	turn.partial.errorMessage = message;
	turn.stream.push({ type: "error", reason: "error", error: turn.partial });
}

function finishAborted(current: Sink): void {
	if (current.closed) return;
	current.partial.stopReason = "aborted";
	current.partial.errorMessage = ABORTED;
	closeSink(current);
	current.stream.push({ type: "error", reason: "aborted", error: current.partial });
}

function finishError(current: Sink, message: string): void {
	if (current.closed) return;
	current.partial.stopReason = "error";
	current.partial.errorMessage = message;
	closeSink(current);
	current.stream.push({ type: "error", reason: "error", error: current.partial });
}

function errorText(error: unknown, scrub: (text: string) => string): string {
	const message = error instanceof Error ? error.message : String(error);
	return scrub(message);
}

function promptText(payload: unknown, fallback: string): string {
	if (payload === undefined) return fallback;
	if (typeof payload === "string") return payload;
	if (typeof payload === "object" && payload !== null && "text" in payload && typeof payload.text === "string") {
		return payload.text;
	}
	return fallback;
}

function applyModelCall(usage: Usage, call: ModelCallTokens | undefined): void {
	if (!call) return;
	const cache = call.cacheReadTokens + call.cacheWriteTokens;
	const cacheFits = cache <= call.inputTokens;
	usage.input = cacheFits ? call.inputTokens - cache : call.inputTokens;
	usage.output = call.outputTokens;
	usage.cacheRead = cacheFits ? call.cacheReadTokens : 0;
	usage.cacheWrite = cacheFits ? call.cacheWriteTokens : 0;
	usage.totalTokens = call.inputTokens + call.outputTokens;
	if (call.reasoningTokens !== undefined) usage.reasoning = call.reasoningTokens;
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
