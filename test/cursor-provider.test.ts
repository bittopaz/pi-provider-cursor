import { existsSync } from "node:fs";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withMutedSdkOutput } from "../src/cursor-output.js";

const sdk = vi.hoisted(() => ({
	create: vi.fn(),
	storeDirs: [] as string[],
}));

vi.mock("@cursor/sdk", () => ({
	Agent: { create: sdk.create },
	Cursor: { models: { list: vi.fn() } },
	emptyFs: () => ({ kind: "empty-fs" }),
	JsonlLocalAgentStore: class {
		rootDir: string;
		constructor(rootDir: string) {
			sdk.storeDirs.push(rootDir);
			this.rootDir = rootDir;
		}
	},
}));

import { cursorModelFromListItem } from "../src/cursor-models.js";
import { resetCursorSession, setCursorToolSource, streamCursor } from "../src/cursor-provider.js";

const model = {
	id: "test-model",
	name: "Test",
	api: "cursor-sdk",
	provider: "cursor",
	baseUrl: "https://cursor.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
} satisfies Model<"cursor-sdk">;

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor-sdk",
		provider: "cursor",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function transcript(messages: Parameters<typeof normalizeContext>[0]["messages"]) {
	return normalizeContext({ messages });
}

describe("streamCursor", () => {
	beforeEach(async () => {
		sdk.create.mockReset();
		sdk.storeDirs.length = 0;
		setCursorToolSource(() => []);
		await resetCursorSession();
	});

	it("reports a missing API key and does not create an agent", async () => {
		const previous = process.env.CURSOR_API_KEY;
		delete process.env.CURSOR_API_KEY;
		try {
			const message = await streamCursor(model, transcript([
				{ role: "user", content: "hello", timestamp: 1 },
			])).result();
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("API key");
			expect(sdk.create).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = previous;
		}
	});

	it("sends the earlier user turn with the current one", async () => {
		const send = vi.fn(async (text: string) => ({
			wait: async () => ({ status: "finished", result: "ok" }),
			cancel: async () => undefined,
		}));
		sdk.create.mockResolvedValue({
			send,
			getUsage: async () => ({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, runs: [] }),
			[Symbol.asyncDispose]: async () => undefined,
		});

		const message = await streamCursor(model, transcript([
			{ role: "user", content: "first turn", timestamp: 1 },
			assistant("ack"),
			{ role: "user", content: "second turn", timestamp: 2 },
		]), { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("stop");
		const text = send.mock.calls[0]?.[0];
		expect(text).toContain("first turn");
		expect(text).toContain("second turn");
		expect(String(text).indexOf("first turn")).toBeLessThan(String(text).indexOf("second turn"));
		expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({
			tools: [],
			model: { id: "test-model" },
			local: { fs: { kind: "empty-fs" } },
		});
	});

	it("sends tool-call arguments and attaches image bytes", async () => {
		const send = vi.fn(async (_message: string | { text: string; images?: { data: string; mimeType: string }[] }) => ({
			wait: async () => ({ status: "finished", result: "ok" }),
			cancel: async () => undefined,
		}));
		sdk.create.mockResolvedValue({
			send,
			getUsage: async () => ({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, runs: [] }),
			[Symbol.asyncDispose]: async () => undefined,
		});

		const message = await streamCursor(model, transcript([
			{
				...assistant(""),
				content: [
				{ type: "thinking", thinking: "hidden-reasoning-marker" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			],
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "see this" },
					{ type: "image", data: "image-bytes-marker", mimeType: "image/png" },
				],
				timestamp: 2,
			},
		]), { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("stop");
		const payload = send.mock.calls[0]?.[0];
		if (typeof payload !== "object" || payload === null) throw new Error("expected an SDK image message");
		expect(payload.text).not.toContain("[tool read]");
		expect(payload.text).toContain('The read tool already ran with {"path":"README.md"}.');
		expect(payload.text).toContain("see this");
		expect(payload.text).not.toContain("image-bytes-marker");
		expect(payload.text).not.toContain("hidden-reasoning-marker");
		expect(payload.images).toEqual([{ data: "image-bytes-marker", mimeType: "image/png" }]);
	});

	function listedModel(item: Parameters<typeof cursorModelFromListItem>[0]): Model<"cursor-sdk"> {
		const listed = cursorModelFromListItem(item);
		if (listed.type === "image" || listed.type === "classifier") throw new Error("expected a chat model");
		return {
			...model,
			id: listed.id,
			name: listed.name,
			reasoning: listed.reasoning,
			thinkingLevelMap: listed.thinkingLevelMap,
			samplingParams: listed.samplingParams,
		};
	}

	function finishedAgent(send: ReturnType<typeof vi.fn>) {
		sdk.create.mockResolvedValue({
			send,
			getUsage: async () => ({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, runs: [] }),
			[Symbol.asyncDispose]: async () => undefined,
		});
	}

	it("sends the selected thinking level as the catalog parameter", async () => {
		const send = vi.fn(async (_text: string, options?: { model?: unknown; onDelta?: (update: unknown) => void }) => ({
			wait: async () => ({ status: "finished", result: "ok" }),
			cancel: async () => undefined,
			options,
		}));
		finishedAgent(send);
		const thinkingModel = listedModel({
			id: "grok-4.7",
			displayName: "Grok 4.7",
			parameters: [{
				id: "reasoning_effort",
				values: [
					{ value: "low" },
					{ value: "medium" },
					{ value: "high" },
					{ value: "xhigh" },
				],
			}],
		});

		const selected = await streamCursor(thinkingModel, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey: "test-key", reasoning: "high" }).result();
		expect(selected.stopReason).toBe("stop");
		const selection = { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] };
		expect(sdk.create.mock.calls[0]?.[0].model).toEqual(selection);
		expect(send.mock.calls[0]?.[1]).toEqual({ model: selection, onDelta: expect.any(Function) });

		sdk.create.mockClear();
		finishedAgent(send);
		const omitted = await streamCursor(thinkingModel, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey: "test-key" }).result();
		expect(omitted.stopReason).toBe("stop");
		expect(sdk.create.mock.calls[0]?.[0].model).toEqual({ id: "grok-4.7" });

		const grok46 = listedModel({
			id: "grok-4.6",
			displayName: "Grok 4.6",
			parameters: [{
				id: "effort",
				values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }],
			}],
		});
		sdk.create.mockClear();
		finishedAgent(send);
		const effort = await streamCursor(grok46, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey: "test-key", reasoning: "xhigh" }).result();
		expect(effort.stopReason).toBe("stop");
		expect(sdk.create.mock.calls[0]?.[0].model).toEqual({
			id: "grok-4.6",
			params: [{ id: "effort", value: "xhigh" }],
		});

		const deepseek = listedModel({
			id: "deepseek-v41-flash-1017",
			displayName: "DeepSeek",
			parameters: [{
				id: "reasoning_effort",
				values: [{ value: "none" }, { value: "low" }, { value: "high" }, { value: "max" }],
			}],
		});
		sdk.create.mockClear();
		finishedAgent(send);
		const off = await streamCursor(deepseek, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey: "test-key" }).result();
		expect(off.stopReason).toBe("stop");
		expect(sdk.create.mock.calls[0]?.[0].model).toEqual({
			id: "deepseek-v41-flash-1017",
			params: [{ id: "reasoning_effort", value: "none" }],
		});
	});

	it("sends fast=false on the Cursor agent when the catalog lists it", async () => {
		const send = vi.fn(async (_text: string, _options?: { model?: unknown; onDelta?: (update: unknown) => void }) => ({
			wait: async () => ({ status: "finished", result: "ok" }),
			cancel: async () => undefined,
		}));
		finishedAgent(send);
		const fastModel = listedModel({
			id: "grok-4.7",
			displayName: "Grok 4.7",
			parameters: [
				{ id: "reasoning_effort", values: [{ value: "high" }] },
				{ id: "fast", values: [{ value: "false" }, { value: "true" }] },
			],
		});

		const selected = await streamCursor(fastModel, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey: "test-key", reasoning: "high" }).result();

		expect(selected.stopReason).toBe("stop");
		const selection = {
			id: "grok-4.7",
			params: [
				{ id: "reasoning_effort", value: "high" },
				{ id: "fast", value: "false" },
			],
		};
		expect(sdk.create.mock.calls[0]?.[0].model).toEqual(selection);
		expect(send.mock.calls[0]?.[1]).toEqual({ model: selection, onDelta: expect.any(Function) });
	});

	it("maps a text delta onto the assistant message", async () => {
		sdk.create.mockResolvedValue({
			send: vi.fn(async (_text: string, options: { onDelta: (args: { update: { type: "text-delta"; text: string } | { type: "model-call-completed"; modelCallId: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } } }) => void }) => {
				options.onDelta({ update: { type: "model-call-completed", modelCallId: "call-1", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
				options.onDelta({ update: { type: "text-delta", text: "pong" } });
				return {
					wait: async () => ({ status: "finished", result: "pong" }),
					cancel: async () => undefined,
				};
			}),
			getUsage: async () => ({ usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }, runs: [] }),
			[Symbol.asyncDispose]: async () => undefined,
		});

		const message = await streamCursor(model, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "pong" }]);
		expect(message.usage.output).toBe(1);
		expect(message.usage.totalTokens).toBe(2);
	});

	it("uses the last model call as context size when the agent bill is larger", async () => {
		sdk.create.mockResolvedValue({
			send: vi.fn(async (_text: string, options: { onDelta: (args: { update: { type: "text-delta"; text: string } | { type: "model-call-completed"; modelCallId: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } } }) => void }) => {
				options.onDelta({ update: { type: "model-call-completed", modelCallId: "call-1", usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 400, cacheWriteTokens: 0 } } });
				options.onDelta({ update: { type: "model-call-completed", modelCallId: "call-2", usage: { inputTokens: 1200, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 0 } } });
				options.onDelta({ update: { type: "text-delta", text: "done" } });
				return {
					wait: async () => ({
						status: "finished",
						result: "done",
						usage: { inputTokens: 908596, outputTokens: 16228, cacheReadTokens: 837248, cacheWriteTokens: 0, totalTokens: 924824 },
					}),
					cancel: async () => undefined,
				};
			}),
			getUsage: async () => ({
				usage: { inputTokens: 908596, outputTokens: 16228, cacheReadTokens: 837248, cacheWriteTokens: 0, totalTokens: 924824 },
				cost: { rawCostCents: 0, chargedCents: 50 },
				runs: [],
			}),
			[Symbol.asyncDispose]: async () => undefined,
		});

		const message = await streamCursor(model, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey: "test-key" }).result();

		expect(message.usage.totalTokens).toBe(1220);
		expect(message.usage.input).toBe(700);
		expect(message.usage.output).toBe(20);
		expect(message.usage.cacheRead).toBe(500);
		expect(message.usage.cost.total).toBe(0.5);
		expect(message.usage.cost.totalFromProvider).toBe(true);
	});

	it("estimates catalog cost when Cursor billing is unavailable", async () => {
		const grok = {
			...model,
			id: "grok-4.6",
			cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
		};
		sdk.create.mockResolvedValue({
			send: vi.fn(async (_text: string, options: { onDelta: (args: { update: { type: "text-delta"; text: string } | { type: "model-call-completed"; modelCallId: string; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens?: number } } }) => void }) => {
				options.onDelta({
					update: {
						type: "model-call-completed",
						modelCallId: "call-1",
						usage: { inputTokens: 3347, outputTokens: 17, cacheReadTokens: 1280, cacheWriteTokens: 0, reasoningTokens: 16 },
					},
				});
				options.onDelta({ update: { type: "text-delta", text: "pong" } });
				return {
					wait: async () => ({ status: "finished", result: "pong" }),
					cancel: async () => undefined,
				};
			}),
			getUsage: async () => {
				throw new Error("[feature_unavailable] This feature is not available for your account");
			},
			[Symbol.asyncDispose]: async () => undefined,
		});

		const message = await streamCursor(grok, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey: "test-key" }).result();

		const total = (2 * 2067 + 6 * 17 + 0.5 * 1280) / 1_000_000;
		expect(message.stopReason).toBe("stop");
		expect(message.usage.input).toBe(2067);
		expect(message.usage.cacheRead).toBe(1280);
		expect(message.usage.output).toBe(17);
		expect(message.usage.cost.total).toBeCloseTo(total, 10);
		expect(message.usage.cost.totalFromProvider).not.toBe(true);
	});

	it("removes the turn store and reports the response", async () => {
		let status: number | undefined;
		sdk.create.mockResolvedValue({
			send: vi.fn(async () => ({
				wait: async () => ({ status: "finished", result: "ok" }),
				cancel: async () => undefined,
			})),
			getUsage: async () => ({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, runs: [] }),
			[Symbol.asyncDispose]: async () => undefined,
		});

		const message = await streamCursor(model, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), {
			apiKey: "test-key",
			onResponse: (response) => {
				status = response.status;
			},
		}).result();

		expect(message.stopReason).toBe("stop");
		expect(status).toBe(200);
		const storeDir = sdk.storeDirs[0];
		expect(storeDir).toEqual(expect.any(String));
		if (!storeDir) return;
		expect(existsSync(storeDir)).toBe(true);
		await resetCursorSession();
		expect(existsSync(storeDir)).toBe(false);
	});

	it("keeps going when abort cancellation fails", async () => {
		const controller = new AbortController();
		let releaseWait: (() => void) | undefined;
		const waitStarted = new Promise<void>((resolve) => {
			releaseWait = resolve;
		});
		sdk.create.mockResolvedValue({
			send: vi.fn(async () => ({
				wait: async () => {
					releaseWait?.();
					await new Promise((resolve) => setTimeout(resolve, 20));
					return { status: "cancelled" };
				},
				cancel: () => Promise.reject(new Error("store failed")),
			})),
			getUsage: async () => ({ usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }, runs: [] }),
			[Symbol.asyncDispose]: async () => undefined,
		});

		const pending = streamCursor(model, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey: "test-key", signal: controller.signal }).result();
		await waitStarted;
		controller.abort();
		const message = await pending;
		expect(message.stopReason).toBe("aborted");
	});

	it("forwards terminal redraws and drops plain sdk logs", async () => {
		const chunks: string[] = [];
		const saved = process.stdout.write;
		function recordWrite(this: unknown, chunk: string | Uint8Array): boolean {
			if (this === undefined) throw new TypeError("kWriteMonkeyPatchDefense");
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}
		process.stdout.write = recordWrite as typeof process.stdout.write;
		try {
			await withMutedSdkOutput(async () => {
				process.stdout.write("sdk log\n");
				process.stdout.write("\u001b[1Aredraw");
				console.log("hidden");
			});
		} finally {
			process.stdout.write = saved;
		}
		expect(chunks).toEqual(["\u001b[1Aredraw"]);
	});

	it("removes the API key from a failed run", async () => {
		const apiKey = "sk-test-secret";
		sdk.create.mockRejectedValue(new Error(`rejected ${apiKey}`));
		const message = await streamCursor(model, transcript([
			{ role: "user", content: "ping", timestamp: 1 },
		]), { apiKey }).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("[redacted]");
		expect(message.errorMessage).not.toContain(apiKey);
	});

	it("sends only the new user text while the agent stays up", async () => {
		const send = vi.fn(async (_text: string) => ({
			wait: async () => ({ status: "finished" as const, result: "ok" }),
			cancel: async () => undefined,
		}));
		finishedAgent(send);

		const first = await streamCursor(model, transcript([
			{ role: "user", content: "first turn", timestamp: 1 },
		]), { apiKey: "test-key" }).result();
		const second = await streamCursor(model, transcript([
			{ role: "user", content: "first turn", timestamp: 1 },
			assistant("ok"),
			{ role: "user", content: "second turn", timestamp: 2 },
		]), { apiKey: "test-key" }).result();

		expect(first.stopReason).toBe("stop");
		expect(second.stopReason).toBe("stop");
		expect(sdk.create).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[1]?.[0]).toBe("second turn");
		expect(String(send.mock.calls[1]?.[0])).not.toContain("first turn");
	});

	it("sends a shorter branch on a new agent", async () => {
		const send = vi.fn(async (_text: string) => ({
			wait: async () => ({ status: "finished" as const, result: "ok" }),
			cancel: async () => undefined,
		}));
		finishedAgent(send);

		const side = await streamCursor(model, transcript([
			{ role: "user", content: "first turn", timestamp: 1 },
			assistant("ack"),
			{ role: "user", content: "side question", timestamp: 2 },
			assistant("side answer"),
		]), { apiKey: "test-key" }).result();
		const branched = await streamCursor(model, transcript([
			{ role: "user", content: "first turn", timestamp: 1 },
			assistant("ack"),
			{ role: "user", content: "the page is blank", timestamp: 3 },
		]), { apiKey: "test-key" }).result();

		expect(side.stopReason).toBe("stop");
		expect(branched.stopReason).toBe("stop");
		expect(branched.errorMessage).toBeUndefined();
		expect(sdk.create).toHaveBeenCalledTimes(2);
		const resent = String(send.mock.calls[1]?.[0]);
		expect(resent).toContain("first turn");
		expect(resent).toContain("the page is blank");
		expect(resent).not.toContain("side question");
	});

	it("sends a changed earlier turn on a new agent", async () => {
		const send = vi.fn(async (_text: string) => ({
			wait: async () => ({ status: "finished" as const, result: "ok" }),
			cancel: async () => undefined,
		}));
		finishedAgent(send);

		const first = await streamCursor(model, transcript([
			{ role: "user", content: "first turn", timestamp: 1 },
			assistant("ack"),
			{ role: "user", content: "side question", timestamp: 2 },
		]), { apiKey: "test-key" }).result();
		const edited = await streamCursor(model, transcript([
			{ role: "user", content: "first turn", timestamp: 1 },
			assistant("ack"),
			{ role: "user", content: "edited question", timestamp: 2 },
			assistant("edited answer"),
			{ role: "user", content: "follow up", timestamp: 4 },
		]), { apiKey: "test-key" }).result();

		expect(first.stopReason).toBe("stop");
		expect(edited.stopReason).toBe("stop");
		expect(edited.errorMessage).toBeUndefined();
		expect(sdk.create).toHaveBeenCalledTimes(2);
		const resent = String(send.mock.calls[1]?.[0]);
		expect(resent).toContain("edited question");
		expect(resent).toContain("follow up");
		expect(resent).not.toContain("side question");
	});

	it("reports no new user text when a continuation adds none", async () => {
		const send = vi.fn(async (_text: string) => ({
			wait: async () => ({ status: "finished" as const, result: "ok" }),
			cancel: async () => undefined,
		}));
		finishedAgent(send);

		const first = await streamCursor(model, transcript([
			{ role: "user", content: "first turn", timestamp: 1 },
		]), { apiKey: "test-key" }).result();
		const again = await streamCursor(model, transcript([
			{ role: "user", content: "first turn", timestamp: 1 },
			assistant("ack"),
		]), { apiKey: "test-key" }).result();

		expect(first.stopReason).toBe("stop");
		expect(again.stopReason).toBe("error");
		expect(again.errorMessage).toBe("Cursor has no new user text.");
		expect(sdk.create).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("returns the Pi tool call and feeds the result back", async () => {
		setCursorToolSource(() => [{
			name: "read",
			description: "Read file contents",
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
		}]);
		let toolResult: Promise<unknown> | undefined;
		const send = vi.fn(async (_text: string, options: {
			local?: { customTools?: { read?: { execute: (args: { path: string }, context: { toolCallId: string }) => Promise<unknown> } } };
		}) => {
			const execute = options.local?.customTools?.read?.execute;
			if (!execute) throw new Error("expected a read custom tool");
			toolResult = execute({ path: "README.org" }, { toolCallId: "call-1" });
			return {
				wait: () => toolResult?.then(
					(result) => ({ status: "finished" as const, result: `saw ${String(result)}` }),
					() => ({ status: "cancelled" as const }),
				),
				cancel: async () => undefined,
			};
		});
		finishedAgent(send);

		const called = await streamCursor(model, transcript([
			{ role: "user", content: "read the notes", timestamp: 1 },
		]), { apiKey: "test-key" }).result();

		expect(called.stopReason).toBe("toolUse");
		expect(called.content).toContainEqual({
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { path: "README.org" },
		});
		expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({
			tools: ["mcp"],
			local: { settingSources: [], fs: { kind: "empty-fs" } },
		});

		const answered = await streamCursor(model, transcript([
			{ role: "user", content: "read the notes", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.org" } }],
				api: "cursor-sdk",
				provider: "cursor",
				model: model.id,
				usage: called.usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "notes body" }],
				isError: false,
				timestamp: 3,
			},
		]), { apiKey: "test-key" }).result();

		expect(answered.stopReason).toBe("stop");
		expect(answered.content).toEqual([{ type: "text", text: "saw notes body" }]);
		expect(sdk.create).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(1);
		await expect(toolResult).resolves.toBe("notes body");
	});

	it("continues from a tool result when that tool call is requested again", async () => {
		setCursorToolSource(() => [{ name: "read", description: "Read file contents" }]);
		let execute: ((args: { path: string }, context: { toolCallId: string }) => Promise<unknown>) | undefined;
		let finish: ((result: string) => void) | undefined;
		const finished = new Promise<{ status: "finished"; result: string }>((resolve) => {
			finish = (result) => resolve({ status: "finished", result });
		});
		const arm = (pending: Promise<unknown>) => {
			pending.then(
				(result) => finish?.(`saw ${String(result)}`),
				() => undefined,
			);
		};
		const send = vi.fn(async (_text: string, options: {
			local?: { customTools?: { read?: { execute: (args: { path: string }, context: { toolCallId: string }) => Promise<unknown> } } };
		}) => {
			execute = options.local?.customTools?.read?.execute;
			if (!execute) throw new Error("expected a read custom tool");
			arm(execute({ path: "README.org" }, { toolCallId: "call-1" }));
			return {
				wait: () => finished,
				cancel: async () => undefined,
			};
		});
		finishedAgent(send);

		const called = await streamCursor(model, transcript([
			{ role: "user", content: "read the notes", timestamp: 1 },
		]), { apiKey: "test-key" }).result();
		expect(called.stopReason).toBe("toolUse");
		if (!execute) throw new Error("expected the read tool to be registered");
		arm(execute({ path: "README.org" }, { toolCallId: "call-1" }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		const continued = await streamCursor(model, transcript([
			{ role: "user", content: "read the notes", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.org" } }],
				api: "cursor-sdk",
				provider: "cursor",
				model: model.id,
				usage: called.usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "notes body" }],
				isError: false,
				timestamp: 3,
			},
		]), { apiKey: "test-key" }).result();

		expect(continued.stopReason).toBe("stop");
		expect(continued.errorMessage).toBeUndefined();
		expect(continued.content).toEqual([{ type: "text", text: "saw notes body" }]);
	});

	it("renames Cursor file_path to Pi path", async () => {
		setCursorToolSource(() => [{ name: "read", description: "Read file contents" }]);
		const send = vi.fn(async (_text: string, options: {
			local?: { customTools?: { read?: { execute: (args: { file_path: string }, context: { toolCallId: string }) => Promise<unknown> } } };
		}) => {
			const execute = options.local?.customTools?.read?.execute;
			if (!execute) throw new Error("expected a read custom tool");
			void execute({ file_path: "/tmp/extensions.md" }, { toolCallId: "call-path" }).catch(() => undefined);
			return {
				wait: async () => ({ status: "finished" as const, result: "ok" }),
				cancel: async () => undefined,
			};
		});
		finishedAgent(send);

		const called = await streamCursor(model, transcript([
			{ role: "user", content: "read the docs", timestamp: 1 },
		]), { apiKey: "test-key" }).result();

		expect(called.stopReason).toBe("toolUse");
		expect(called.content).toContainEqual({
			type: "toolCall",
			id: "call-path",
			name: "read",
			arguments: { path: "/tmp/extensions.md" },
		});
	});

	it("rejects the parked tool and stops the run when Pi aborts", async () => {
		setCursorToolSource(() => [{ name: "read", description: "Read file contents" }]);
		const controller = new AbortController();
		let toolResult: Promise<unknown> | undefined;
		const send = vi.fn(async (_text: string, options: {
			local?: { customTools?: { read?: { execute: (args: { path: string }, context: { toolCallId: string }) => Promise<unknown> } } };
		}) => {
			const execute = options.local?.customTools?.read?.execute;
			if (!execute) throw new Error("expected a read custom tool");
			toolResult = execute({ path: "big.log" }, { toolCallId: "call-9" });
			return {
				wait: () => toolResult?.then(
					() => ({ status: "finished" as const, result: "should-not-continue" }),
					() => ({ status: "cancelled" as const }),
				),
				cancel: async () => undefined,
			};
		});
		finishedAgent(send);

		const called = await streamCursor(model, transcript([
			{ role: "user", content: "read the log", timestamp: 1 },
		]), { apiKey: "test-key", signal: controller.signal }).result();
		expect(called.stopReason).toBe("toolUse");
		controller.abort();
		await expect(toolResult).rejects.toThrow("Operation aborted");

		const stopped = await streamCursor(model, transcript([
			{ role: "user", content: "read the log", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-9", name: "read", arguments: { path: "big.log" } }],
				api: "cursor-sdk",
				provider: "cursor",
				model: model.id,
				usage: called.usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-9",
				toolName: "read",
				content: [{ type: "text", text: "Operation aborted" }],
				isError: true,
				timestamp: 3,
			},
		]), { apiKey: "test-key", signal: controller.signal }).result();
		expect(stopped.stopReason).toBe("aborted");
		expect(JSON.stringify(stopped.content)).not.toContain("should-not-continue");
	});
});
