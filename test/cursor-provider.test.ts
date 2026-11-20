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

import { streamCursor } from "../src/cursor-provider.js";

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
	beforeEach(() => {
		sdk.create.mockReset();
		sdk.storeDirs.length = 0;
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

	it("sends tool-call arguments and omits image bytes", async () => {
		const send = vi.fn(async (_text: string) => ({
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
		const text = String(send.mock.calls[0]?.[0]);
		expect(text).toContain('[tool read] {"path":"README.md"}');
		expect(text).toContain("see this");
		expect(text).not.toContain("image-bytes-marker");
		expect(text).not.toContain("hidden-reasoning-marker");
	});

	it("maps a text delta onto the assistant message", async () => {
		sdk.create.mockResolvedValue({
			send: vi.fn(async (_text: string, options: { onDelta: (args: { update: { type: "text-delta"; text: string } }) => void }) => {
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
		if (storeDir) expect(existsSync(storeDir)).toBe(false);
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
		process.stdout.write = ((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;
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
});
