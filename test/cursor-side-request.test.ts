import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	create: vi.fn(),
	storeDirs: [] as string[],
}));

const auth = vi.hoisted(() => ({
	readStoredCredential: vi.fn((): { type: "api_key"; key: string } | undefined => undefined),
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

vi.mock("@earendil-works/pi-coding-agent", () => ({
	readStoredCredential: auth.readStoredCredential,
}));

import { completeCursorSideRequest } from "../src/cursor-side-request.js";

const model = {
	id: "grok-4.7",
	thinkingLevelMap: { minimal: "low", off: "none" },
	samplingParams: { cursorThinkingParameter: "reasoning" },
};

describe("completeCursorSideRequest", () => {
	beforeEach(() => {
		sdk.create.mockReset();
		sdk.storeDirs.length = 0;
		auth.readStoredCredential.mockReset();
		auth.readStoredCredential.mockReturnValue(undefined);
		delete process.env.CURSOR_API_KEY;
	});

	it("returns an error and does not create an agent when no key is stored", async () => {
		const result = await completeCursorSideRequest({ model, prompt: "name this" });
		expect(result.stopReason).toBe("error");
		expect(result.text).toBe("");
		expect(sdk.create).not.toHaveBeenCalled();
	});

	it("returns aborted before creating an agent when the signal is already aborted", async () => {
		process.env.CURSOR_API_KEY = "test-key";
		const signal = AbortSignal.abort();
		const result = await completeCursorSideRequest({ model, prompt: "name this", signal });
		expect(result).toEqual({ text: "", stopReason: "aborted" });
		expect(sdk.create).not.toHaveBeenCalled();
	});

	it("asks a new tool-free agent and leaves no store behind", async () => {
		process.env.CURSOR_API_KEY = "test-key";
		const dispose = vi.fn(async () => undefined);
		const send = vi.fn(async () => ({
			wait: async () => ({ status: "finished", result: "Delete remote tags" }),
			cancel: async () => undefined,
		}));
		sdk.create.mockResolvedValue({ send, [Symbol.asyncDispose]: dispose });

		const result = await completeCursorSideRequest({
			model,
			prompt: "Name the session",
			reasoning: "minimal",
		});

		expect(result).toEqual({ text: "Delete remote tags", stopReason: "stop" });
		expect(send).toHaveBeenCalledWith("Name the session", {
			model: { id: "grok-4.7", params: [{ id: "reasoning", value: "low" }] },
			onDelta: expect.any(Function),
		});
		expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({
			apiKey: "test-key",
			tools: [],
			model: { id: "grok-4.7", params: [{ id: "reasoning", value: "low" }] },
			local: { fs: { kind: "empty-fs" }, settingSources: [] },
		});
		expect(dispose).toHaveBeenCalledOnce();
		expect(sdk.storeDirs).toHaveLength(1);
		expect(existsSync(sdk.storeDirs[0]!)).toBe(false);
	});

	it("uses the stored Cursor key ahead of the environment", async () => {
		process.env.CURSOR_API_KEY = "env-key";
		auth.readStoredCredential.mockReturnValue({ type: "api_key", key: "stored-key" });
		sdk.create.mockResolvedValue({
			send: async () => ({ wait: async () => ({ status: "finished", result: "ok" }), cancel: async () => undefined }),
			[Symbol.asyncDispose]: async () => undefined,
		});

		await completeCursorSideRequest({ model, prompt: "name" });

		expect(sdk.create.mock.calls[0]?.[0]).toMatchObject({ apiKey: "stored-key" });
	});

	it("scrubs the API key from a failed run", async () => {
		process.env.CURSOR_API_KEY = "secret-key";
		sdk.create.mockResolvedValue({
			send: async () => ({
				wait: async () => ({ status: "error", error: { message: "rejected secret-key" } }),
				cancel: async () => undefined,
			}),
			[Symbol.asyncDispose]: async () => undefined,
		});

		const result = await completeCursorSideRequest({ model, prompt: "name" });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("rejected [redacted]");
		expect(result.errorMessage).not.toContain("secret-key");
	});
});
