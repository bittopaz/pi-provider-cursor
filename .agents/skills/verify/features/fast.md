# Keep fast off

Keep fast off sends `fast=false` for a Cursor model whose saved catalog lists that value. The thinking level does not change it.

## Sub-features

- `fast-off` records `fast=false` on the SDK run for `cursor/grok-4.6` at thinking `low`.

## How to get to it (user POV)

- Run `pi -e <repo> --model cursor/grok-4.6 --thinking low` and send a prompt.
- The same model at `off`, `minimal`, `medium`, `high`, `xhigh`, or `max` also sends `fast=false` when the catalog lists that value. This harness drives `low`.

## Driving it with verify.sh

Preconditions:

- `verify.sh prepare` printed `catalog=remembered`.
- `verify.sh doctor` printed `auth api_key` and `grok-4.6` at `256K` with thinking `yes`.
- The copied `cursor-sdk-model-list.json` lists a `fast` value of `false` for `grok-4.6`.

- **Ask at low.** Run `.agents/skills/verify/verify.sh fast`. The command exits 0. The last assistant `message_end` has provider `cursor`, model `grok-4.6`, and `stopReason` `stop`. The assistant text contains `pong` and is at most 200 characters. The last `agent_settled` event has `aborted` false.
- **Read the request.** `evidence/fast/store/<id>/runs.ndjson` contains a model selection with id `grok-4.6` and a parameter `fast=false`. No captured selection has `fast` set to `true`.
- **Unmet catalog.** When prepare printed `catalog=fallback`, or the saved catalog has no `fast=false` value for `grok-4.6`, the command exits 2. That exit is a skipped proof, not a pass.

## Gotchas

- Pi's reply does not include the `fast` parameter. The provider deletes the SDK store when the agent is disposed. The harness copies `runs.ndjson` while that process is still running.
- `grok-4.6`, `grok-4.5`, `grok-4.7`, and `composer-2.5` list `fast` in the saved catalog, and the catalog default is `fast=true`. Leaving the parameter out selects that default. This drive checks `grok-4.6` only.
- A model with no `fast` parameter is not this feature.
- This drive is a billed completion. Do not run it after a drive whose reported cost already exceeded $5.
