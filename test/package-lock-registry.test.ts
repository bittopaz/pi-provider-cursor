import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package-lock.json registries", () => {
	it("resolves every package from the public npm registry", () => {
		const lock: unknown = JSON.parse(readFileSync("package-lock.json", "utf8"));
		const packages =
			lock && typeof lock === "object" && "packages" in lock && lock.packages && typeof lock.packages === "object"
				? Object.values(lock.packages)
				: [];
		const offenders = packages
			.map((entry) => (entry && typeof entry === "object" && "resolved" in entry ? entry.resolved : undefined))
			.filter(
				(resolved): resolved is string =>
					typeof resolved === "string" && !resolved.startsWith("https://registry.npmjs.org/"),
			);
		expect(
			offenders,
			"package-lock.json must not record an internal registry. " +
				"Rewrite each resolved value to its https://registry.npmjs.org/ form " +
				"(same path, unchanged integrity) before committing.",
		).toEqual([]);
	});
});
