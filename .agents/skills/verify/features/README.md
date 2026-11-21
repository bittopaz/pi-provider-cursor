# pi-cursor-sdk verification map

This directory is the maintained source for verifying the user-facing behavior of the Cursor provider in Pi. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Run `verify.sh prepare` so `dist/index.js` is built and `/tmp/pi-cursor-verify/$VERIFY_RUN_ID/run/` holds a copied Cursor API key.
- Keep `VERIFY_RUN_ID` the same for prepare, doctor, drive, and cleanup.
- Run `verify.sh doctor` and require `auth api_key` plus a `cursor grok-4.6` row at context `256K`.
- Drive from that run's scratch directory. Never point `PI_CODING_AGENT_DIR` at `~/.pi/agent`.
- A copied saved model list (`catalog=remembered` from prepare) is required for the thinking feature and the fast feature. The reply, tool, and continue features also run on the fallback list.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Treat every command as literal. Keep model ids, flags, and marker strings unchanged.
- Run drives through `.agents/skills/verify/verify.sh`.
- One drive is one Pi process. A second `VERIFY_RUN_ID` is a different instance.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the JSONL stream, stderr, and `meta.txt`. The stream contains the user message and the assistant result.
- Completion proof includes `provider=cursor`, the requested model, `stopReason=stop`, `agent_settled` with `aborted=false`, and the marker in the assistant text.
- Tool proof includes a successful tool event for the feature's tool (`read` or `fixture_marker`) and the same text in the assistant reply.
- Record the feature name and the `events.jsonl` path with the result.
- Report an unmet precondition with the command that exited 2. Do not report a skipped entry point as verified through a different command.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.sh`, and `Gotchas`.

## Features

- [Get a reply](./reply.md) covers one print-mode prompt to `cursor/grok-4.6` and the missing-key failure.
- [List Cursor models](./models.md) covers the saved catalog and the single-model fallback.
- [Set a thinking level](./thinking.md) covers `--thinking low` on `cursor/grok-4.6` when the saved catalog publishes thinking.
- [Keep fast off](./fast.md) covers `fast=false` on `cursor/grok-4.6` when the saved catalog lists that value.
- [Call a Pi tool through Cursor](./tool.md) covers a `read` tool call against a scratch file and a `fixture_marker` call registered by a second extension, proving every active Pi tool reaches Cursor.
- [Send a second message](./continue.md) covers two prompts in one Pi process.
