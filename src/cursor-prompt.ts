import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";

function joinText(parts: readonly string[]): string {
	return parts.filter((text) => text.length > 0).join("\n");
}

function userOrResultBlock(block: TextContent | ImageContent): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "image":
			return "";
		default: {
			const unreachable: never = block;
			return unreachable;
		}
	}
}

function assistantBlock(block: TextContent | ThinkingContent | ToolCall): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "thinking":
			return "";
		case "toolCall":
			return `[tool ${block.name}] ${JSON.stringify(block.arguments)}`;
		default: {
			const unreachable: never = block;
			return unreachable;
		}
	}
}

function messageText(message: UserMessage | AssistantMessage | ToolResultMessage): string {
	if (message.role === "toolResult") {
		const body = joinText(message.content.map((block) => userOrResultBlock(block)));
		return message.isError ? `Error: ${body}` : body;
	}
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return joinText(message.content.map((block) => userOrResultBlock(block)));
	}
	return joinText(message.content.map((block) => assistantBlock(block)));
}

function roleLabel(message: UserMessage | AssistantMessage | ToolResultMessage): string {
	if (message.role === "user") return "User";
	if (message.role === "assistant") return "Assistant";
	return `Tool result (${message.toolName})`;
}

export function buildCursorPrompt(messages: readonly Message[]): string {
	const parts: string[] = [];
	const system = getCurrentSystemPrompt(messages).trim();
	if (system) parts.push(system);
	for (const message of messages) {
		if (message.role === "system") continue;
		const text = messageText(message).trim();
		if (!text) continue;
		parts.push(`${roleLabel(message)}\n${text}`);
	}
	return parts.join("\n\n");
}
