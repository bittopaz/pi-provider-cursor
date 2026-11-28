# pi-provider-cursor

This project is a fork of [pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk), renamed to pi-provider-cursor.

Pi provider that calls a Cursor model and returns the text.

## Install

```sh
pi install npm:pi-provider-cursor
```

For a one-off run, `pi -e npm:pi-provider-cursor` loads it without installing. To work on a checkout, run `pi -e .` from the repo root.

Set `CURSOR_API_KEY`, or run `/login` and choose Cursor. Then select a `cursor/` model:

```sh
pi --model cursor/grok-4.6
```

## Agent behavior

One local Cursor agent stays up for the Pi session. The first turn sends the Pi transcript. Later turns send only the new user text. A new agent, after a shutdown or a failed run, replays the transcript with each past tool call written as "The read tool already ran with ...". Thinking text from earlier turns is left out of the replay. The agent's files are deleted when the agent is disposed, including session shutdown.

## Isolation

`Agent.create` sets `local.fs` to an empty in-memory tree and `local.settingSources` to `[]`, so the model does not receive the host workspace, Cursor rules, or Cursor plugins.

## Tools

When Pi has any active tools, the agent is created with `tools: ["mcp"]` and every active Pi tool is passed on `send` as `local.customTools`, extension tools such as `agent` included. The model calls them through Cursor's MCP meta-tool. Pi runs the tool, and the result goes back through that call. Escape rejects the call and cancels the run. With no active tools, `tools` stays `[]`.

## Models, thinking, and fast

`Cursor.models.list` fills the model list. Pi checks your saved models before that call is allowed, so the last successful list for the same API key is used at startup. If the call fails, or there is no API key, the list is the single model `grok-4.6`.

The SDK does not report a context window. Published windows are 200000 for `composer-2.5`, `default`, and `glm-5.2`, 256000 for `grok-4.5` and `grok-4.6`, 262144 for `kimi-k2.7-code`, 500000 for `grok-4.7`, 1000000 for `glm-5p3` and `glm-5p3-flash`, and 1048576 for `deepseek-v41-flash-1017` and `kimi-k3`. An id without one of those windows stays at 128000. Output stays 16384.

Every model accepts images. Image parts are sent on the SDK message and left out of the transcript text.

A model whose catalog lists a reasoning or effort parameter accepts a Pi thinking level. The picker shows the levels that catalog lists, and the selected level is sent as that parameter. Models without one stay reasoning off. When the catalog lists a `fast` value of `false`, every request sends `fast=false`, at every thinking level, so the catalog default never applies. When the catalog lists a context value equal to the published window, that value is sent.

## Side requests

Extensions can run a one-off Cursor completion outside the chat stream through the `pi-provider-cursor/side-request` export:

```ts
import { completeCursorSideRequest } from "pi-provider-cursor/side-request";

const result = await completeCursorSideRequest({
  model: { id: "grok-4.6" },
  prompt: "Name this session in five words.",
});
```

The call resolves with `{ text, stopReason }`, or with `{ stopReason: "error", errorMessage }` instead of throwing: a missing API key is an error result, not an exception. Each call uses a temporary agent store that is deleted when the call settles. Session naming is the known consumer. A custom `systemPrompt` works only on Cursor accounts with that entitlement; other accounts get an error result.

## Develop

```sh
npm test
npm run typecheck
npm run build
```

Node 24.22.3 or newer on the 24 line, or Node 26.13.1 or newer. The Cursor SDK dependency is `@cursor/sdk` 1.4.1.
