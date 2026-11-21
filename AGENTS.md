# AGENTS.md

This package is a Pi extension. It registers the `cursor` provider, lists models with `Cursor.models.list`, and streams a local `Agent.send` while keeping that agent for the Pi session.

## Contract

- `@cursor/sdk` is 1.4.1. Read the installed types before changing `Agent.create`, `agent.send`, `tools`, or `Cursor.models.list`.
- Local agents only. `local.fs` is `emptyFs()`, so the host workspace is not attached. `local.settingSources` is `[]`, so Cursor rules, plugins, and Cursor MCP config stay unloaded.
- When Pi has any of `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, `ls`, `codemode`, or `tool_search` active, `tools` is `["mcp"]` and that send passes those tools as `local.customTools`. Otherwise `tools` is `[]`. A custom tool call returns to Pi as `toolUse`. Pi runs the tool. The next provider call resolves the parked call with the tool result. Escape rejects the parked call and cancels the run.
- One agent stays for the session. The first send is the transcript. Later sends are the new user text. A replay writes each past tool call as "The <name> tool already ran with <arguments>." Do not write `[tool name]` lines. Dispose the agent on shutdown, abort, or a failed run.
- When Pi refreshes models without network, publish the last successful `Cursor.models.list` for the same API key. A failed model list, including a missing API key, publishes `grok-4.6` only.
- Scrub the API key out of errors. Mute stderr, console, and plain stdout while the SDK call runs. Terminal redraws, which contain an escape character, pass through.
- When a catalog model has a `reasoning`, `reasoning_effort`, `effort`, or `thinking` parameter, publish `reasoning: true` and map Pi thinking levels onto the values that parameter lists. `off` uses `none`, `off`, or `false` when that value exists. Send the selected level as that parameter on `Agent.create` and `agent.send`. Models without that parameter stay `reasoning: false`. Do not send `fast`. When the catalog lists a `context` value equal to the published window, send that value too.
- Publish these context windows: `composer-2.5`, `default`, `glm-5.2`, `kimi-k2.7-code`, and `kimi-k3` at 200000, `grok-4.5` and `grok-4.6` at 256000, `grok-4.7` at 500000, `glm-5p3` and `glm-5p3-flash` at 1000000, and `deepseek-v41-flash-1017` at 1048576. An unknown id stays at 128000. Output stays 16384. Every model accepts images. Image parts go on the SDK message and stay out of the transcript text.
- Omit thinking text when the transcript is sent again.
- Keep the session's `JsonlLocalAgentStore` in a temporary directory and delete that directory after the agent is disposed.

## Checks

`npm test`, `npm run typecheck`, and `npm run build`. The GitHub workflows run those commands.

A behavior change that the types do not settle needs one real Cursor call. Keep that call under $5. Use a short prompt, read `usage.cost.total` when the SDK reports it, and do not send a second prompt if the first call already reached the cap.
