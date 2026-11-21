# Set a thinking level

Set a thinking level chooses `low` for `cursor/grok-4.6` and still returns an assistant reply.

## Sub-features

- `thinking-low` accepts `--thinking low` on the saved `grok-4.6` entry and returns text.

## How to get to it (user POV)

- Run `pi -e <repo> --model cursor/grok-4.6 --thinking low`.
- Run `pi -e <repo> --model cursor/grok-4.6:low`.
- In the interactive session, set the thinking level to `low` before sending a prompt.

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` printed `mode=remembered` and `grok-4.6` thinking `yes`.
- The fallback catalog does not satisfy this feature.

- **Ask at low.** Run `.agents/skills/verify/verify.sh thinking`. The command exits 0. The last assistant `message_end` has provider `cursor`, model `grok-4.6`, and `stopReason` `stop`.
- **Read the reply.** The assistant text contains `pong` and is at most 200 characters. The last `agent_settled` event has `aborted` false.
- **Unmet catalog.** When prepare printed `catalog=fallback`, the command exits 2 and prints that the saved catalog is required. That exit is a skipped proof, not a pass.

## Gotchas

- `grok-4.6` in the saved catalog accepts `low`, `medium`, `high`, and `xhigh`. It has no `off` value, so a request for `off` is clamped to `low`.
- Thinking text may be absent at `low`. Empty thinking text is not a failure. An error stop reason is.
- This drive is a second billed completion. Do not run it after a drive whose reported cost already exceeded $5.
