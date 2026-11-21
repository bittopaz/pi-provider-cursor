import { describe, expect, it } from "vitest";
import { normalizeCursorApiKey, resolveCursorApiKey } from "../src/cursor-api-key.js";

describe("normalizeCursorApiKey", () => {
	it("drops blank values, env-var stand-ins, and placeholder sentinels", () => {
		expect(normalizeCursorApiKey(undefined)).toBeUndefined();
		expect(normalizeCursorApiKey("  ")).toBeUndefined();
		expect(normalizeCursorApiKey("CURSOR_API_KEY")).toBeUndefined();
		expect(normalizeCursorApiKey("$CURSOR_API_KEY")).toBeUndefined();
		expect(normalizeCursorApiKey("${CURSOR_API_KEY}")).toBeUndefined();
		expect(normalizeCursorApiKey("pi-provider-cursor-cursor-api-key-placeholder")).toBeUndefined();
		expect(normalizeCursorApiKey("former-package-cursor-api-key-placeholder")).toBeUndefined();
	});

	it("returns a trimmed key", () => {
		expect(normalizeCursorApiKey("  crsr_test  ")).toBe("crsr_test");
	});
});

describe("resolveCursorApiKey", () => {
	it("uses the env key when the argument is a placeholder", () => {
		const previous = process.env.CURSOR_API_KEY;
		process.env.CURSOR_API_KEY = "env-key";
		try {
			expect(resolveCursorApiKey("pi-provider-cursor-cursor-api-key-placeholder")).toBe("env-key");
		} finally {
			if (previous === undefined) delete process.env.CURSOR_API_KEY;
			else process.env.CURSOR_API_KEY = previous;
		}
	});
});
