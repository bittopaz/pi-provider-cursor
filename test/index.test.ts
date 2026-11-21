import { describe, expect, it } from "vitest";
import { cursorToolSpecs } from "../src/index.js";

const objectSchema = { type: "object", properties: { prompt: { type: "string" } } };

describe("cursorToolSpecs", () => {
	it("forwards every active tool, including extension tools outside the former allowlist", () => {
		const specs = cursorToolSpecs(
			[
				{ name: "read", description: "Read file contents", parameters: objectSchema },
				{ name: "agent", description: "Launch a subagent", parameters: objectSchema },
				{ name: "lsp_definition", description: "Resolve a symbol", parameters: objectSchema },
			],
			["read", "agent", "lsp_definition"],
		);
		expect(specs.map((spec) => spec.name)).toEqual(["read", "agent", "lsp_definition"]);
		expect(specs[1]?.inputSchema).toEqual(objectSchema);
	});

	it("drops tools that are not active", () => {
		const specs = cursorToolSpecs(
			[
				{ name: "read", description: "Read file contents", parameters: objectSchema },
				{ name: "agent", description: "Launch a subagent", parameters: objectSchema },
			],
			["read"],
		);
		expect(specs.map((spec) => spec.name)).toEqual(["read"]);
	});

	it("omits the input schema when the parameters do not round-trip to a plain object", () => {
		const specs = cursorToolSpecs(
			[{ name: "noop", description: "No parameters", parameters: () => true }],
			["noop"],
		);
		expect(specs).toEqual([{ name: "noop", description: "No parameters" }]);
	});
});
