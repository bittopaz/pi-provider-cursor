import { describe, expect, it } from "vitest";
import { buildCursorPiToolDisplayFromSpec } from "../src/cursor-transcript-tool-specs.js";
import {
	CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE,
	parseCursorReplayToolDetails,
} from "../src/cursor-replay-tool-details.js";
import { renderCursorReplayResult } from "../src/cursor-native-tool-display-replay.js";
import { getCursorToolActivityReplaySpec } from "../src/cursor-tool-presentation-registry.js";
import { createRenderContext, createRenderTheme } from "./helpers/render-fixtures.js";

const theme = createRenderTheme();

function renderReplayResult(details: unknown, text = "ok", isError = false): string {
	return renderCursorReplayResult(
		{ content: [{ type: "text", text }], details },
		{ expanded: false, isPartial: false },
		theme,
		createRenderContext({ isError, showImages: false }),
		isError,
	)
		.render(120)
		.join("\n");
}

describe("cursor replay tool details contract", () => {
	it("does not upgrade payloads without current replay variants", () => {
		expect(parseCursorReplayToolDetails({ path: "src/a.ts" })).toBeUndefined();
		expect(parseCursorReplayToolDetails({ variant: "activity", title: "Cursor MCP" })).toMatchObject({
			variant: "activity",
			sourceToolName: "unregisteredActivity",
			title: "Cursor MCP",
		});
		expect(parseCursorReplayToolDetails({ variant: "edit", path: "src/a.ts" })).toBeUndefined();
	});

	it("parses activity details and ignores unknown fields at the boundary", () => {
		const parsed = parseCursorReplayToolDetails({
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
			untrusted: "drop-me",
		});
		expect(parsed).toMatchObject({
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: "git status",
			expandedText: "line one",
		});
		expect(parsed).not.toHaveProperty("untrusted");
	});

	it("parses explicit nativeEdit and nativeWrite variants without title reclassification", () => {
		const edit = parseCursorReplayToolDetails({
			variant: "nativeEdit",
			title: "Cursor edit",
			path: "src/a.ts",
			diffString: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
			linesAdded: 1,
		});
		const write = parseCursorReplayToolDetails({
			variant: "nativeWrite",
			title: "Cursor write",
			path: "out.txt",
			linesCreated: 3,
		});

		expect(edit).toMatchObject({ variant: "nativeEdit", path: "src/a.ts" });
		expect(edit).not.toHaveProperty("title");
		expect(write).toMatchObject({ variant: "nativeWrite", path: "out.txt" });
		expect(write).not.toHaveProperty("title");
	});

	it("keeps genericFallback strict instead of repairing known source names in render parsing", () => {
		const edit = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "edit",
			path: "src/a.ts",
			diffString: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
			linesAdded: 1,
		});
		const write = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "write",
			path: "out.txt",
			linesCreated: 2,
		});
		const image = parseCursorReplayToolDetails({
			variant: "genericFallback",
			sourceToolName: "generateImage",
			imagePath: "/tmp/out.png",
		});

		expect(edit).toMatchObject({ variant: "genericFallback", sourceToolName: "edit" });
		expect(write).toMatchObject({ variant: "genericFallback", sourceToolName: "write" });
		expect(image).toMatchObject({ variant: "genericFallback", sourceToolName: "generateImage" });
	});

	it("renders generateImage producer details with the current visible title and path", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "success", value: { filePath: "/tmp/generated.png" }, error: undefined },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");
		const details = parseCursorReplayToolDetails(display.result.details);
		expect(details).toMatchObject({ variant: "generateImage", imagePath: "/tmp/generated.png" });
		expect(details).not.toHaveProperty("title");
		expect(rendered).toContain(`${CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE} generated.png`);
		expect(rendered).not.toContain("Cursor generateImage");
	});

	it.each([
		["edit", "no match", "Cursor edit"],
		["write", "permission denied", "write src/a.ts"],
	] as const)("renders path-only %s errors with the activity error body", (name, error, expectedText) => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: name,
			name,
			args: { path: "src/a.ts" },
			result: { status: "error", value: undefined, error },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "", true);

		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: name,
			title: `Cursor ${name}`,
		});
		expect(rendered).toContain(expectedText);
		expect(rendered).toContain(`Error: ${error}`);
		expect(rendered.split("\n")).not.toContain(`${name} src/a.ts`);
	});

	it("renders path-only edit no-change results with the Cursor edit activity title", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "edit",
			name: "edit",
			args: { path: "src/a.ts" },
			result: { status: "success", value: { linesAdded: 0, linesRemoved: 0 }, error: undefined },
			options: { cwd: "/repo", maxChars: 4000 },
		});
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		expect(display.result.details).toMatchObject({
			variant: "activity",
			sourceToolName: "edit",
			title: "Cursor edit",
		});
		expect(rendered).toContain("Cursor edit");
		expect(rendered).not.toMatch(/^edit src\/a\.ts$/m);
	});

	it("renders generateImage producer error details with the current visible title", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "generateImage",
			name: "generateImage",
			args: { prompt: "a red circle" },
			result: { status: "error", value: undefined, error: "image generation failed" },
			options: { cwd: "/tmp", maxChars: 4000 },
		});
		const rendered = renderCursorReplayResult(
			{
				content: display.result.content,
				details: display.result.details,
			},
			{ expanded: false, isPartial: false },
			theme,
			createRenderContext({ isError: true, showImages: false }),
			true,
		)
			.render(120)
			.join("\n");
		expect(rendered).toContain(CURSOR_REPLAY_GENERATE_IMAGE_RESULT_TITLE);
		expect(rendered).not.toContain("Cursor generateImage");
		expect(rendered).not.toMatch(/^image generation failed$/m);
	});
});

describe("cursor mcp activity collapsed rendering", () => {
	const listing = JSON.stringify([
		{ name: "slack_read_channel", title: "Read channel messages", description: "Reads messages from a Slack channel" },
		{ name: "slack_post_message", title: "Post message", description: "Posts a message" },
	]);

	function displayFor(value: unknown) {
		return buildCursorPiToolDisplayFromSpec({
			rawName: "mcp",
			name: "mcp",
			args: { type: "MCP", toolName: "search_tools", args: { pattern: "slack" } },
			result: { status: "success", value, error: undefined },
			options: { cwd: "/tmp", maxChars: 400_000 },
		});
	}

	it("collapses to the summary alone instead of dumping the payload", () => {
		const display = displayFor({ content: [{ type: "text", text: listing }] });
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");
		const lines = rendered.split("\n").filter((line) => line.trim());

		expect(lines).toHaveLength(1);
		expect(rendered).toContain("Cursor MCP search_tools");
		// The listing names itself, so the summary carries the first tool rather than raw JSON.
		expect(rendered).toContain("slack_read_channel");
		expect(rendered).not.toContain('{"name"');
	});

	it("names the called tool for an object payload", () => {
		const display = displayFor({ content: [{ type: "text", text: JSON.stringify({ toolName: "slack_post_message", ok: true }) }] });
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		expect(rendered).toContain("slack_post_message");
		expect(rendered).not.toContain('{"toolName"');
	});

	it("keeps prose previews unchanged", () => {
		const display = displayFor({ content: [{ type: "text", text: "call_readonly_tool needs a tool name.\n\nMore detail" }] });
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		expect(rendered).toContain("call_readonly_tool needs a tool name.");
	});

	it("still shows the full payload once expanded", () => {
		const display = displayFor({ content: [{ type: "text", text: listing }] });
		const rendered = renderCursorReplayResult(
			{ content: display.result.content, details: display.result.details },
			{ expanded: true, isPartial: false },
			theme,
			createRenderContext({ isError: false, showImages: false }),
			false,
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain("slack_post_message");
		expect(rendered.split("\n").filter((line) => line.trim()).length).toBeGreaterThan(1);
	});

	it("expands a payload far larger than the collapsed budget without truncating it", () => {
		// A cap on the expanded path would still satisfy the assertion above, since the fixture is
		// small, so this one uses a payload bigger than any preview limit in the code.
		const big = JSON.stringify(
			Array.from({ length: 200 }, (_, i) => ({ name: `tool_${i}`, description: "x".repeat(60) })),
		);
		expect(big.length).toBeGreaterThan(12_000);
		const display = displayFor({ content: [{ type: "text", text: big }] });
		const rendered = renderCursorReplayResult(
			{ content: display.result.content, details: display.result.details },
			{ expanded: true, isPartial: false },
			theme,
			createRenderContext({ isError: false, showImages: false }),
			false,
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain("tool_199");
		expect(rendered).not.toMatch(/truncat/i);
	});

	it("collapses rows recorded before the mcp spec collapsed details", () => {
		// Shape written by an earlier version: no collapse flag, and a truncated JSON fragment as the
		// preview. A resumed session replays exactly this.
		const legacy = {
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: 'search_tools · [{"name":"sonarqube_analyze_code_snippet","title":"SonarQube Cod…',
			expandedText: 'search_tools\n\n[{"name":"sonarqube_analyze_code_snippet","description":"Analyze a file"}]',
		};
		const rendered = renderReplayResult(legacy, 'search_tools\n\n[{"name":"sonarqube_analyze_code_snippet"}]');
		const lines = rendered.split("\n").filter((line) => line.trim());

		expect(lines).toHaveLength(1);
		expect(rendered).not.toContain('{"name"');
		// Without this, a regression that empties the summary entirely still passes the two above.
		expect(rendered).toContain("Cursor MCP search_tools · sonarqube_analyze_code_snippet");
	});

	it("keeps a non-JSON legacy preview, which a current row writes on purpose", () => {
		const rendered = renderReplayResult({
			variant: "activity",
			sourceToolName: "mcp",
			title: "Cursor MCP",
			summary: "call_readonly_tool · call_readonly_tool needs the name of a tool",
			expandedText: "body",
		});

		expect(rendered).toContain("call_readonly_tool · call_readonly_tool needs the name of a tool");
	});

	it("keeps bracket-led prose, which starts like a payload but is a sentence", () => {
		// A renderer that treats a leading bracket as JSON deletes these, and they are what the writer
		// recorded from prose results.
		for (const preview of [
			"[deprecated] use other_tool instead",
			"{error}: missing required field {name}",
			"[tool error] upstream 503",
			"[content omitted]",
		]) {
			const rendered = renderReplayResult({
				variant: "activity",
				sourceToolName: "mcp",
				title: "Cursor MCP",
				summary: `call_tool · ${preview}`,
				expandedText: `call_tool\n\n${preview}`,
			});
			expect(rendered).toContain(preview);
		}
	});

	it("recovers the tool name from the payload when the recorded preview is a fragment", () => {
		const rendered = renderReplayResult(
			{
				variant: "activity",
				sourceToolName: "mcp",
				title: "Cursor MCP",
				summary: 'call_tool · {"id":"52936161","ti',
				expandedText: 'call_tool\n\n{\n  "id": "52936161",\n  "title": "Get issue",\n  "name": "atlassian_getJiraIssue"\n}',
			},
			'call_tool\n\n{\n  "id": "52936161",\n  "title": "Get issue"\n}',
		);

		expect(rendered).toContain("atlassian_getJiraIssue");
		expect(rendered).not.toContain('"id"');
		expect(rendered.split("\n").filter((line) => line.trim())).toHaveLength(1);
	});

	it("shows the error an MCP payload carries instead of a bare tool name", () => {
		const display = displayFor({ isError: true, content: [{ type: "text", text: '{"error":"permission denied","code":403}' }] });
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		expect(rendered).toContain("permission denied");
	});

	it("shows a message when the payload names no tool", () => {
		const display = displayFor({ content: [{ type: "text", text: '{"message":"Rate limited, retry in 30s"}' }] });
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		expect(rendered).toContain("Rate limited, retry in 30s");
	});

	it("names an entry wrapped in a results envelope", () => {
		const display = displayFor({ content: [{ type: "text", text: '{"results":[{"id":"ari:x","title":"A page about auth"}]}' }] });
		const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

		// An opaque identifier is not a summary, so the human-readable title wins.
		expect(rendered).toContain("A page about auth");
		expect(rendered).not.toContain("ari:x");
	});

	it("shows a bare tool name for a payload that says nothing", () => {
		for (const text of ["[]", "{}", "[1,2,3]", '["alpha","beta"]']) {
			const display = displayFor({ content: [{ type: "text", text }] });
			const rendered = renderReplayResult(display.result.details, display.result.content[0]?.text ?? "");

			expect(rendered.trim()).toBe("Cursor MCP search_tools");
		}
	});
});

describe("cursor replay collapse contract", () => {
	it("writes the collapse flag for every spec that collapses its details", () => {
		// The renderer falls back to the spec for rows recorded before the flag existed. A spec that
		// collapses new rows through buildDetails but omits the data field leaves old rows expanded, so
		// the two must agree.
		const context = {
			args: {},
			result: { status: "success", value: {}, error: undefined },
			options: { cwd: "/tmp", maxChars: 400_000 },
		} as never;

		for (const source of ["mcp", "webSearch", "webFetch"] as const) {
			const spec = getCursorToolActivityReplaySpec(source);
			expect(spec?.collapseDetailsByDefault).toBe(true);
			expect(spec?.buildDetails(context, "x".repeat(500))).toMatchObject({ collapseDetailsByDefault: true });
		}
	});

	it("records the flag on a display built from a real result", () => {
		const display = buildCursorPiToolDisplayFromSpec({
			rawName: "mcp",
			name: "mcp",
			args: { type: "MCP", toolName: "search_tools", args: {} },
			result: { status: "success", value: { content: [{ type: "text", text: '{"name":"a_tool"}' }] }, error: undefined },
			options: { cwd: "/tmp", maxChars: 400_000 },
		});

		expect(display.result.details).toMatchObject({ collapseDetailsByDefault: true });
	});
});
