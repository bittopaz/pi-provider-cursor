# AGENTS.md

This package is a Pi extension. It registers the `cursor` provider, lists models with `Cursor.models.list`, and streams one local `Agent.send` per turn.

## Contract

- `@cursor/sdk` is 1.4.1. Read the installed types before changing `Agent.create`, `agent.send`, `tools`, or `Cursor.models.list`.
- Local agents only. `tools` is `[]`. `local.fs` is `emptyFs()`, so the host workspace is not attached.
- The prompt is the Pi transcript for that turn. Do not resume an SDK agent.
- A failed model list, including a missing API key, publishes `grok-4.6` only.
- Scrub the API key out of errors. Mute stderr, console, and plain stdout while the SDK call runs. Terminal redraws, which contain an escape character, pass through.
- Publish every model with `reasoning: false`. Do not send a thinking parameter.
- Omit thinking text when the transcript is sent again.
- Keep the turn's `JsonlLocalAgentStore` in a temporary directory and delete that directory after the agent is disposed.

## Checks

`npm test`, `npm run typecheck`, and `npm run build`. The GitHub workflows run those commands.

A behavior change that the types do not settle needs one real Cursor call. Keep that call under $5. Use a short prompt, read `usage.cost.total` when the SDK reports it, and do not send a second prompt if the first call already reached the cap.
