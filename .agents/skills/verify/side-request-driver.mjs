#!/usr/bin/env node
// Drives the package's ./side-request export once against the built dist and
// prints one JSON line: { result, leftover }. verify.sh asserts on that line.
// Usage: node side-request-driver.mjs <repo-root>
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
if (!root) {
	console.error("usage: node side-request-driver.mjs <repo-root>");
	process.exit(2);
}

const { completeCursorSideRequest } = await import(
	pathToFileURL(join(root, "dist", "cursor-side-request.js")).href
);

const sideStores = () =>
	readdirSync(tmpdir()).filter((name) => name.startsWith("pi-cursor-side-"));

const before = new Set(sideStores());
const result = await completeCursorSideRequest({
	model: { id: "grok-4.6" },
	prompt: "Reply with the single word pong.",
});
const leftover = sideStores().filter((name) => !before.has(name));

process.stdout.write(`${JSON.stringify({ result, leftover })}\n`);
