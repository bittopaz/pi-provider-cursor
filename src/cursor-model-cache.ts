import { hash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelListItem } from "@cursor/sdk";

const CACHE_FILE = "cursor-sdk-model-list.json";
const CACHE_VERSION = 1;

function fingerprint(apiKey: string): string {
	return hash("sha256", apiKey, "hex").slice(0, 16);
}

function isListItem(value: unknown): value is ModelListItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return typeof item.id === "string" && item.id.length > 0 && typeof item.displayName === "string";
}

export function readCachedCursorModels(apiKey: string, dir: string): ModelListItem[] | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, CACHE_FILE), "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.version !== CACHE_VERSION || record.keyFingerprint !== fingerprint(apiKey)) return undefined;
		if (!Array.isArray(record.models) || record.models.length === 0 || !record.models.every(isListItem)) return undefined;
		return record.models;
	} catch {
		return undefined;
	}
}

export function writeCachedCursorModels(apiKey: string, models: ModelListItem[], dir: string): void {
	if (models.length === 0) return;
	try {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, CACHE_FILE);
		const data = {
			version: CACHE_VERSION,
			fetchedAt: Date.now(),
			keyFingerprint: fingerprint(apiKey),
			models,
		};
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		chmodSync(path, 0o600);
	} catch {
		// Remembering the list is optional. A failed write still returns the live list.
	}
}
