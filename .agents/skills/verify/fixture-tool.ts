// Fixture extension for the toolext drive. It registers a tool no provider
// allowlist could contain, so the drive fails if the provider ever filters
// which active Pi tools reach Cursor. Loaded as a second -e beside the repo.
// The repo has no top-level typebox dependency; import the nested copy the
// SDK package installs.
import { Type } from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs";

export default function (pi) {
	pi.registerTool({
		name: "fixture_marker",
		label: "Fixture Marker",
		description: "Return a fixed marker string. Used by the pi-cursor-sdk verify harness.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "fixture-marker" }] };
		},
	});
}
