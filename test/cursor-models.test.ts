import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
	list: vi.fn(),
}));

vi.mock("@cursor/sdk", () => ({
	Agent: { create: vi.fn() },
	Cursor: { models: { list: sdk.list } },
}));

import { FALLBACK_CURSOR_MODEL_ID, loadCursorModels } from "../src/cursor-models.js";

describe("loadCursorModels", () => {
	beforeEach(() => {
		sdk.list.mockReset();
	});

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

	it("uses the fallback model when listing fails", async () => {
		sdk.list.mockRejectedValue(new Error("offline"));
		const models = await loadCursorModels("test-key");
		expect(models.map((item) => item.id)).toEqual([FALLBACK_CURSOR_MODEL_ID]);
	});
});
