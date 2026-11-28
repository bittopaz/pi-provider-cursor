# Ask for a side completion

Ask for a side completion runs one prompt through the package's `./side-request` export, the entry point other extensions use for work outside the chat stream, and returns the model's text.

## Sub-features

- `side-request-text` returns assistant text for a single prompt through `completeCursorSideRequest`.
- `side-request-store` removes the temporary SDK store when the call settles.

## How to get to it (user POV)

- Another Pi extension imports `completeCursorSideRequest` from `pi-provider-cursor/side-request` and awaits it with a model id and a prompt. Session naming is the known consumer.
- The caller gets a result object with `text` and `stopReason`; a failure resolves with `stopReason` `error` and `errorMessage` instead of throwing.

## Driving it with verify.sh

Preconditions:

- `verify.sh prepare` finished, so `dist/cursor-side-request.js` is built.
- `verify.sh doctor` printed `auth api_key` and a `grok-4.6` row.

- **Ask.** Run `.agents/skills/verify/verify.sh sidereq`. The command exits 0. It runs [`.agents/skills/verify/side-request-driver.mjs`](../side-request-driver.mjs) with the run's copied credential, `CURSOR_API_KEY` unset, and the scratch directory as the working directory.
- **Read the reply.** `evidence/side-request/result.json` holds one JSON record whose `result` has `stopReason` `stop` and text containing `pong`, at most 200 characters.
- **See the store removed.** The same record's `leftover` list is empty: every `pi-cursor-side-*` store directory the call created under the temp directory is gone when the promise settles.
- **Missing key.** With no Cursor credential in the agent directory, the call resolves with `stopReason` `error` and the provider's missing-key text. The harness does not drive that path.

## Gotchas

- The driver passes `{ id: "grok-4.6" }` with no `samplingParams`, so the request sends no thinking, fast, or context parameter. This drive proves text, stop reason, and store cleanup only.
- This drive is a billed completion with no usage record: `completeCursorSideRequest` does not report cost. Keep the prompt short and do not loop the drive.
- The store is deleted inside the driver's own process, on error as well as on success. `verify.sh cleanup` has nothing to remove for this feature.
- The `leftover` check compares against stores present before the call, so a `pi-cursor-side-*` directory from another process does not fail the drive.
- The driver sets no `systemPrompt`. Cursor rejects a custom system prompt with `stopReason` `error` on accounts without that entitlement, so a drive that sets one can fail on the account, not on the code.
