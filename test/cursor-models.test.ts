import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	list: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
	Agent: { create: vi.fn() },
	Cursor: { models: { list: sdk.list } },
}));

import { FALLBACK_CURSOR_MODEL_ID, cursorModelFromListItem, cursorModelSelection, loadCursorModels, rememberedCursorModels } from "../src/cursor-models.js";

function listTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

function parameter(id: string, values: string[]) {
	return { id, values: values.map((value) => ({ value })) };
}

describe("loadCursorModels", () => {
	const dirs: string[] = [];

	beforeEach(() => {
		sdk.list.mockReset();
	});

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-cursor-models-"));
		dirs.push(dir);
		return dir;
	}

	it("maps a catalog id and display name", async () => {
		sdk.list.mockResolvedValue([
			{ id: "test-model", displayName: "Test Model", parameters: [{ id: "thinking", values: [] }] },
		]);
		const models = await loadCursorModels("test-key");
		expect(models).toEqual([
			expect.objectContaining({ id: "test-model", name: "Test Model", reasoning: false }),
		]);
		expect(sdk.list).toHaveBeenCalledWith({ apiKey: "test-key" });
	});

	it("publishes thinking levels the catalog lists", async () => {
		sdk.list.mockResolvedValue([
			{
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
			},
			{
				id: "deepseek-v41-flash-1017",
				displayName: "DeepSeek",
				parameters: [{
					id: "reasoning_effort",
					values: [
						{ value: "none" },
						{ value: "low" },
						{ value: "high" },
						{ value: "max" },
					],
				}],
			},
			{
				id: "composer-2.5",
				displayName: "Composer 2.5",
				parameters: [{ id: "fast", values: [{ value: "true" }, { value: "false" }] }],
			},
		]);
		const models = await loadCursorModels("test-key");
		expect(models[0]).toMatchObject({
			id: "grok-4.7",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: null,
			},
		});
		expect(models[1]).toMatchObject({
			id: "deepseek-v41-flash-1017",
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: "low",
				medium: null,
				high: "high",
				xhigh: null,
				max: "max",
			},
		});
		const composer = models[2];
		if (!composer || composer.type === "image" || composer.type === "classifier") {
			throw new Error("expected a chat model");
		}
		expect(composer).toMatchObject({ id: "composer-2.5", reasoning: false });
		expect(composer.thinkingLevelMap).toBeUndefined();
	});

	it("publishes the context window, thinking flag, and image input Pi lists", async () => {
		const catalog = [
			{ id: "composer-2.5", displayName: "Composer 2.5", parameters: [parameter("fast", ["false", "true"])] },
			{ id: "deepseek-v41-flash-1017", displayName: "DeepSeek", parameters: [parameter("reasoning_effort", ["none", "low", "medium", "high", "max"])] },
			{ id: "default", displayName: "Auto" },
			{ id: "glm-5.2", displayName: "GLM 5.2", parameters: [parameter("reasoning", ["high", "max"])] },
			{ id: "glm-5p3", displayName: "GLM 5.3", parameters: [parameter("reasoning", ["low", "high", "max"])] },
			{ id: "glm-5p3-flash", displayName: "GLM 5.3 Flash", parameters: [parameter("reasoning", ["low", "high", "max"])] },
			{ id: "grok-4.5", displayName: "Grok 4.5", parameters: [parameter("effort", ["low", "medium", "high"])] },
			{ id: "grok-4.6", displayName: "Grok 4.6", parameters: [parameter("effort", ["low", "medium", "high", "xhigh"])] },
			{
				id: "grok-4.7",
				displayName: "Grok 4.7",
				parameters: [
					parameter("context", ["256k", "500k"]),
					parameter("reasoning_effort", ["low", "medium", "high", "xhigh"]),
					parameter("fast", ["false", "true"]),
				],
			},
			{ id: "kimi-k2.7-code", displayName: "Kimi K2.7 Code" },
			{ id: "kimi-k3", displayName: "Kimi K3", parameters: [parameter("reasoning", ["low", "high", "max"])] },
		];
		const expected = [
			["composer-2.5", "200K", "no"],
			["deepseek-v41-flash-1017", "1.0M", "yes"],
			["default", "200K", "no"],
			["glm-5.2", "200K", "yes"],
			["glm-5p3", "1M", "yes"],
			["glm-5p3-flash", "1M", "yes"],
			["grok-4.5", "256K", "yes"],
			["grok-4.6", "256K", "yes"],
			["grok-4.7", "500K", "yes"],
			["kimi-k2.7-code", "262.1K", "no"],
			["kimi-k3", "1.0M", "yes"],
		] as const;
		const rows = catalog.map((item) => {
			const model = cursorModelFromListItem(item);
			if (model.type === "image" || model.type === "classifier") throw new Error("expected a chat model");
			return [
				model.id,
				listTokenCount(model.contextWindow),
				model.reasoning ? "yes" : "no",
				listTokenCount(model.maxTokens),
				model.input.includes("image") ? "yes" : "no",
			];
		});
		expect(rows).toEqual(expected.map(([id, context, thinking]) => [id, context, thinking, "16.4K", "yes"]));
		const grokItem = catalog.find((item) => item.id === "grok-4.7");
		if (!grokItem) throw new Error("missing grok-4.7");
		const grok = cursorModelFromListItem(grokItem);
		expect(cursorModelSelection(grok, "high")).toEqual({
			id: "grok-4.7",
			params: [
				{ id: "context", value: "500k" },
				{ id: "reasoning_effort", value: "high" },
				{ id: "fast", value: "false" },
			],
		});
		expect(cursorModelSelection(grok, undefined)).toEqual({
			id: "grok-4.7",
			params: [
				{ id: "context", value: "500k" },
				{ id: "fast", value: "false" },
			],
		});
		const composerItem = catalog.find((item) => item.id === "composer-2.5");
		if (!composerItem) throw new Error("missing composer-2.5");
		expect(cursorModelSelection(cursorModelFromListItem(composerItem), undefined)).toEqual({
			id: "composer-2.5",
			params: [{ id: "fast", value: "false" }],
		});
	});

	it("uses the fallback model when listing fails", async () => {
		sdk.list.mockRejectedValue(new Error("offline"));
		const models = await loadCursorModels("test-key");
		expect(models.map((item) => item.id)).toEqual([FALLBACK_CURSOR_MODEL_ID]);
		expect(models[0]).toMatchObject({
			contextWindow: 256_000,
			input: ["text", "image"],
			reasoning: false,
		});
	});

	it("remembers a successful list and reuses it without network", async () => {
		const dir = tempDir();
		sdk.list.mockResolvedValue([
			{ id: "glm-5p3", displayName: "GLM 5.3" },
			{ id: "grok-4.7", displayName: "Grok 4.7" },
		]);
		const listed = await loadCursorModels("test-key", dir);
		expect(listed.map((item) => item.id)).toEqual(["glm-5p3", "grok-4.7"]);
		expect(readFileSync(join(dir, "cursor-sdk-model-list.json"), "utf8")).not.toContain("test-key");

		const remembered = rememberedCursorModels("test-key", dir);
		expect(remembered.map((item) => item.id)).toEqual(["glm-5p3", "grok-4.7"]);
		expect(rememberedCursorModels("other-key", dir).map((item) => item.id)).toEqual([FALLBACK_CURSOR_MODEL_ID]);
		expect(sdk.list).toHaveBeenCalledTimes(1);
	});

	it("sends fast=false at every thinking level", () => {
		const grok = cursorModelFromListItem({
			id: "grok-4.7",
			displayName: "Grok 4.7",
			parameters: [
				parameter("context", ["256k", "500k"]),
				parameter("reasoning_effort", ["low", "medium", "high", "xhigh"]),
				parameter("fast", ["false", "true"]),
			],
		});
		const context = { id: "context", value: "500k" };
		const fast = { id: "fast", value: "false" };
		expect(cursorModelSelection(grok, "low").params).toEqual([context, { id: "reasoning_effort", value: "low" }, fast]);
		expect(cursorModelSelection(grok, "medium").params).toEqual([context, { id: "reasoning_effort", value: "medium" }, fast]);
		expect(cursorModelSelection(grok, "high").params).toEqual([context, { id: "reasoning_effort", value: "high" }, fast]);
		expect(cursorModelSelection(grok, "xhigh").params).toEqual([context, { id: "reasoning_effort", value: "xhigh" }, fast]);
		for (const level of ["off", "minimal", "max", undefined]) {
			expect(cursorModelSelection(grok, level).params).toEqual([context, fast]);
		}

		const composer = cursorModelFromListItem({
			id: "composer-2.5",
			displayName: "Composer 2.5",
			parameters: [parameter("fast", ["false", "true"])],
		});
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", undefined]) {
			expect(cursorModelSelection(composer, level)).toEqual({
				id: "composer-2.5",
				params: [fast],
			});
		}
	});

	it("sends fast=false only when the catalog lists that value", () => {
		const fastOnly = cursorModelFromListItem({
			id: "composer-2.5",
			displayName: "Composer 2.5",
			parameters: [parameter("fast", ["true"])],
		});
		expect(cursorModelSelection(fastOnly, "high")).toEqual({ id: "composer-2.5" });

		const noFast = cursorModelFromListItem({
			id: "kimi-k3",
			displayName: "Kimi K3",
			parameters: [parameter("reasoning", ["low", "high"])],
		});
		expect(cursorModelSelection(noFast, "high")).toEqual({
			id: "kimi-k3",
			params: [{ id: "reasoning", value: "high" }],
		});
	});

	it("publishes the documented per-million token rates", () => {
		expect(cursorModelFromListItem({ id: "grok-4.6", displayName: "Grok 4.6" }).cost).toEqual({
			input: 2,
			output: 6,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
		expect(cursorModelFromListItem({ id: "grok-4.5", displayName: "Grok 4.5" }).cost).toEqual({
			input: 2,
			output: 6,
			cacheRead: 0.5,
			cacheWrite: 0,
		});
		expect(cursorModelFromListItem({ id: "grok-4.7", displayName: "Grok 4.7" }).cost).toEqual({
			input: 4,
			output: 12,
			cacheRead: 1,
			cacheWrite: 0,
		});
		expect(cursorModelFromListItem({ id: "composer-2.5", displayName: "Composer 2.5" }).cost).toEqual({
			input: 0.5,
			output: 2.5,
			cacheRead: 0.2,
			cacheWrite: 0,
		});
		expect(cursorModelFromListItem({ id: "kimi-k3", displayName: "Kimi" }).cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("does not remember a failed list", async () => {
		const dir = tempDir();
		sdk.list.mockRejectedValue(new Error("offline"));
		await loadCursorModels("test-key", dir);
		expect(rememberedCursorModels("test-key", dir).map((item) => item.id)).toEqual([FALLBACK_CURSOR_MODEL_ID]);
	});
});
