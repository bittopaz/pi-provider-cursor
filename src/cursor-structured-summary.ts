import { asRecord, getString } from "./cursor-record-utils.js";

/**
 * Reading a preview out of a tool result.
 *
 * MCP tools usually answer with JSON, so the first line of a result is often a whole document on one
 * line: a tool catalog, a Jira issue, a page listing. Truncating that line yields decoration such as
 * `[{"name":"sonarqube_analyze` rather than a summary. A name, an error, or a message is readable; a
 * fragment of an object is not.
 *
 * Both the code that writes a row and the code that renders a row recorded by an older version come
 * through here, so the two cannot disagree about what a payload is. They did once: the writer parsed
 * JSON while the renderer tested for a leading bracket, and the renderer then deleted previews the
 * writer had written on purpose, such as `[deprecated] use other_tool instead`.
 */

/** Field a listing or a call payload names itself with, in priority order. */
const NAME_FIELDS = ["name", "toolName", "tool", "title"] as const;

/**
 * Field carrying a human-readable outcome when the payload names no tool, checked before giving up.
 *
 * Without it an MCP error such as `{"error":"permission denied"}` renders as a bare tool name that
 * looks like success.
 */
const MESSAGE_FIELDS = ["error", "message", "detail"] as const;

/**
 * Characters that can follow an opening bracket in a JSON document.
 *
 * Deliberately excludes `t`, `f`, and `n`: a document that is nothing but a literal is useless as a
 * preview, while bracket-led prose such as `[tool error] upstream 503` starts with them and must not
 * be mistaken for a payload.
 */
const JSON_BODY_START = new Set(['"', "[", "{", "]", "}", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

/** A quoted field value, for payloads too fragmented or too large to parse. */
const FIELD_NAMES: readonly string[] = [...NAME_FIELDS, ...MESSAGE_FIELDS];
const FIELD_PATTERNS = new Map(
	FIELD_NAMES.map((field) => [field, new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,120})`, "u")]),
);

/**
 * Whether text opens a JSON document, judged without parsing it.
 *
 * A recorded preview is truncated, so it usually cannot be parsed. This decides whether to read a
 * field out of it instead of showing it as prose.
 */
function looksStructured(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return false;
	const next = trimmed.slice(1).trimStart()[0];
	return next !== undefined && JSON_BODY_START.has(next);
}

/** First value of `fields` on the entry or, for a listing that wraps its items, on their children. */
function entryField(entry: unknown, fields: readonly string[], depth = 0): string | undefined {
	const record = asRecord(entry);
	if (!record) return undefined;
	for (const field of fields) {
		const value = getString(record, field);
		if (value?.trim()) return value.trim();
	}
	// Listings commonly wrap their items, as in `{"results":[{"title":"A page"}]}`.
	const nested = record.results;
	if (depth < 2 && Array.isArray(nested)) {
		for (const child of nested) {
			const found = entryField(child, fields, depth + 1);
			if (found) return found;
		}
	}
	return undefined;
}

/** First entry field present, across a JSON array or a single object. */
function firstField(value: unknown, fields: readonly string[]): string | undefined {
	for (const entry of Array.isArray(value) ? value : [value]) {
		const found = entryField(entry, fields);
		if (found) return found;
	}
	return undefined;
}

/** Reads one quoted field out of text that is not a parseable document. */
function fragmentField(text: string, fields: readonly string[]): string | undefined {
	for (const field of fields) {
		const match = FIELD_PATTERNS.get(field)?.exec(text);
		const value = match?.[1]?.replace(/\\u[0-9a-fA-F]{4}|\\["\\/bfnrt]/gu, " ").trim();
		if (value) return value;
	}
	return undefined;
}
/**
 * Name, error, or message carried by a structured document, or undefined when it carries neither.
 *
 * The document is parsed when it is small enough to be a single recorded line; a large or truncated
 * one is read for the same fields directly.
 */
function structuredField(text: string, maxLength?: number): string | undefined {
	const trimmed = text.trim();
	if (maxLength === undefined || trimmed.length <= maxLength) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			return firstField(parsed, NAME_FIELDS) ?? firstField(parsed, MESSAGE_FIELDS);
		} catch {
			// Truncated or not a document after all, so fall through to reading fields from the text.
		}
	}
	return fragmentField(trimmed, NAME_FIELDS) ?? fragmentField(trimmed, MESSAGE_FIELDS);
}

/**
 * Preview for one line of a tool result.
 *
 * A structured line yields the name, error, or message it carries, or nothing when it carries none:
 * a bare tool name reads better than an opening fragment of an object. Any other line is prose and
 * is excerpted as before. A lone bracket is the first line of a pretty-printed document, not prose.
 */
export function previewFromLine(line: string, maxLength = 120): string | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	if (looksStructured(trimmed)) return structuredField(trimmed);
	if (/^[[\]{}\s]+$/u.test(trimmed)) return undefined;
	return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

/**
 * Preview for a whole result body.
 *
 * Pretty-printed JSON spans many lines, so a name or an error is looked for across the joined text
 * before the first line is treated as prose. This lets a recorded payload be read for a name instead
 * of showing its opening bracket.
 */
export function previewFromText(text: string, maxLength = 120): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	if (looksStructured(trimmed)) return structuredField(trimmed, 4000);
	// Prose: the first non-empty line is the sentence, as a single-line preview has always been.
	const line = trimmed.split("\n").find((candidate) => candidate.trim());
	return line ? previewFromLine(line, maxLength) : undefined;
}
