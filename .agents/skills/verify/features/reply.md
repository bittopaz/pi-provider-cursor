# Get a reply

Get a reply sends one prompt to `cursor/grok-4.6` and shows the assistant text from that model.

## Sub-features

- `reply-text` returns assistant text for a single prompt.
- `reply-isolated` runs against the scratch directory, not the repo and not the user's Pi config.
- `reply-needs-key` stops before a completion when no Cursor API key is configured.

## How to get to it (user POV)

- Run `pi -e <repo> --model cursor/grok-4.6` and enter a prompt.
- Run `pi -e <repo> --model cursor/grok-4.6 -p -- "Reply with the single word pong."` for one shot that exits.

## Driving it with verify.sh

Preconditions:

- `verify.sh prepare` finished and printed `catalog=remembered` or `catalog=fallback`.
- `verify.sh doctor` printed `auth api_key` and a `grok-4.6` row at `256K`.

- **Ask.** Send one prompt with tools off. Run `.agents/skills/verify/verify.sh reply`. The command exits 0. `evidence/reply/events.jsonl` has a session `cwd` that is the run scratch directory after resolving symlinks (`/tmp` and `/private/tmp` are the same directory on macOS), and the last assistant `message_end` has provider `cursor`, model `grok-4.6`, and `stopReason` `stop`.
- **Read the reply.** Open the assistant text in that event. It contains `pong` and is at most 200 characters. The last `agent_settled` event has `aborted` false.
- **Confirm the proof files.** `evidence/reply/stderr.txt` and `evidence/reply/meta.txt` exist. `meta.txt` records the exit code and `usage.cost.total`, which the provider fills on every completion from the catalog rate table or Cursor's billed amount.
- **Missing key.** This path is not the happy-path command. A Pi process whose agent directory has no Cursor credential, run with the same model and `--no-tools -p`, exits non-zero and prints `No API key found for cursor.` on stderr. That line comes from Pi's credential layer; the provider has its own missing-key text when reached, and the harness does not assert either string. Do not treat the stderr line as a successful reply.

## Gotchas

- With a saved catalog, `grok-4.6` publishes thinking and has no `off` level. `--thinking off` is clamped upward to `low`. The fallback list, which is only `grok-4.6` with thinking `no`, keeps thinking off.
- The harness system prompt is two sentences. A pass does not prove the default coding-assistant prompt.
- The drive passes `--thinking off`, which a saved catalog clamps upward to `low`, and the request also sends `fast=false` when the catalog lists that value. This feature proves the reply text only; [Set a thinking level](./thinking.md) and [Keep fast off](./fast.md) cover those parameters.
- The drive passes `--no-tools`, while the user POV commands run with the default tool set. Tools change the request shape: the provider forwards every active tool to Cursor. [Call a Pi tool through Cursor](./tool.md) covers that path.
- `stopReason` `error`, empty text, or `agent_settled` `aborted` true fails the feature even if some text was streamed.
- A cost above $5 fails the run. Do not send another prompt in that run.
