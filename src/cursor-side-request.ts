import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

export interface CursorSideRequest {
	model: Model<any>;
	prompt: string;
	systemPrompt?: string;
	signal?: AbortSignal;
	maxTokens?: number;
	reasoning?: ThinkingLevel;
}

export interface CursorSideResult {
	text: string;
	stopReason: string;
	errorMessage?: string;
}

/** Active-session handle shared by extension copies through the v1 process slot. */
export interface CursorSideRequestSlot {
	readonly binding: { readonly active: boolean; readonly closed: boolean };
	run(request: CursorSideRequest): Promise<CursorSideResult>;
}

const SIDE_REQUEST_KEY = Symbol.for("pi-cursor-sdk.side-request.v1");
const UNAVAILABLE = "Cursor side requests need an active Cursor session. Reload Pi and retry.";

type SideRequestProcessState = typeof globalThis & { [SIDE_REQUEST_KEY]?: CursorSideRequestSlot };

const processState = globalThis as SideRequestProcessState;

export function registerCursorSideRequest(slot: CursorSideRequestSlot): void {
	processState[SIDE_REQUEST_KEY] = slot;
}

export function clearCursorSideRequest(slot: CursorSideRequestSlot): void {
	if (processState[SIDE_REQUEST_KEY] === slot) delete processState[SIDE_REQUEST_KEY];
}

/**
 * Ask the active Cursor session a question outside the conversation.
 * The session marks the request as a tool-free summary and returns its text.
 */
export function completeCursorSideRequest(request: CursorSideRequest): Promise<CursorSideResult> {
	const slot = processState[SIDE_REQUEST_KEY];
	if (!slot || slot.binding.closed || !slot.binding.active) throw new Error(UNAVAILABLE);
	return slot.run(request);
}
