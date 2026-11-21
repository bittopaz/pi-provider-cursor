---
name: verify
description: Drive pi-provider-cursor through an isolated Pi print session and prove Cursor model listing, replies, thinking, fast off, tool use, and a second turn. Use when verifying this extension's user-facing provider behavior.
---

# Verify pi-provider-cursor

The user-facing surface is the Pi CLI with this package loaded (`pi -e <repo> --model cursor/<id>`). Print JSON mode is the harness. There is no server and no port. Interactive TUI rendering is outside this harness; model resolution and the reply stream are the same extension path.

Two runs can proceed side by side when each has its own `VERIFY_RUN_ID`. Do not point `PI_CODING_AGENT_DIR` at `~/.pi/agent`. That directory is the user's live Pi config.

## Launch

From the repo root, with Node `>=24.22.3 <25` or `>=26.13.1` and `pi` on `PATH`:

```sh
export VERIFY_RUN_ID="verify-$(date +%Y%m%dT%H%M%S)"
.agents/skills/verify/verify.sh prepare
```

`prepare` checks Node, runs `npm run build` so `dist/index.js` matches the source, and creates `/tmp/pi-cursor-verify/$VERIFY_RUN_ID/`:

- `run/agent/` receives a copy of `~/.pi/agent/auth.json` when that file exists. If it does not, and `CURSOR_API_KEY` is set, `prepare` writes an `api_key` credential from that variable. The child Pi process is started with `CURSOR_API_KEY` unset so the copied credential is the one that is used.
- `run/agent/cursor-sdk-model-list.json` is copied from `~/.pi/agent/` when both the credential and that saved list exist. `catalog=remembered` means the copy happened. `catalog=fallback` means Pi will publish only `grok-4.6`.
- `run/scratch/` is the process working directory for every drive. It starts empty.
- `run/sessions/` is passed as `--session-dir`. Drives also pass `--no-session`.
- `evidence/` is the proof directory. Cleanup does not remove it.

Ready means `verify.sh doctor` prints `auth api_key` and a `grok-4.6` row. A process that exits before that is not ready.

This package does not migrate or seed a database. The saved model list is the only local catalog state, and it is optional.

## Doctor

```sh
.agents/skills/verify/verify.sh doctor
```

Doctor is read-only aside from writing `evidence/doctor.txt` and `evidence/models.txt`. It checks:

- `node -v` satisfies the `package.json` engines range, and `pi --version` prints a version.
- `dist/index.js` exists under the repo.
- `run/agent/auth.json` is a Cursor `api_key` credential with a non-empty key. The key is not printed.
- `PI_OFFLINE=1 pi -e <repo> --list-models cursor/` shows the table asserted in [features/models.md](features/models.md). Offline listing reads the copied saved list; it does not call Cursor.

Exit 0 means the instance is worth a drive. Exit 1 means it is not: missing credential, missing `grok-4.6`, a known model with the wrong context window, or a copied saved list that still published the fallback row (`grok-4.6`, thinking `no`).

## Drive

Common flags, as executed by `verify.sh`: working directory is `run/scratch`; `PI_CODING_AGENT_DIR` is `run/agent`; `PI_SKIP_VERSION_CHECK=1`; `CURSOR_API_KEY` is unset in the child; `--no-extensions --no-skills --no-context-files --no-mcp --no-themes --no-prompt-templates --no-approve --no-session --mode json -e <repo>`; system prompt is `You are a concise assistant. Follow the user request exactly.`

The short system prompt, disabled tools (unless the feature enables one), and skipped skills and context files are part of the harness. They keep one drive cheap and off the repo. They do not exercise the default coding-assistant prompt.

| Feature | Command |
|---|---|
| Reply | `verify.sh reply` |
| Model table | `verify.sh models` |
| Thinking level | `verify.sh thinking` |
| Fast off | `verify.sh fast` |
| Read a file | `verify.sh tool` |
| Extension tool | `verify.sh toolext` |
| Second turn | `verify.sh continue` |

Recipes and pass conditions are in [features/](features/README.md). Drive one feature per invocation. A feature whose precondition is unmet exits 2 and names the gap; do not count another feature as a substitute.

A drive that spends money is a real Cursor completion. Read `usage.cost.total` on the last assistant `message_end` when it is present. Stop if that value is greater than 5. Do not send a follow-up prompt after a run that already reached the cap.

## Evidence

Proof is written under `/tmp/pi-cursor-verify/$VERIFY_RUN_ID/evidence/`:

- `doctor.txt` and `models.txt` for the catalog check.
- `<feature>/events.jsonl` for the Pi JSONL stream (the action and the resulting messages).
- `<feature>/stderr.txt` for Pi's stderr.
- `<feature>/meta.txt` for the exit code and the assertion summary, including cost when Pi reports it.
- `fast/store/<id>/runs.ndjson` for the SDK model selection copied while the fast drive is still running.

Pass for a completion feature requires all of:

- The session header `cwd` is `run/scratch` after resolving symlinks, not the repo and not `~/.pi/agent`. On macOS, `/tmp` and `/private/tmp` are that same directory.
- The last assistant `message_end` has `provider` `cursor`, the requested model id, and `stopReason` `stop`.
- The assistant text contains the requested marker (`pong`, `verify-marker`, `fixture-marker`, or `amber`) and is at most 200 characters.
- The last `agent_settled` event has `aborted` `false`.
- For the tool features, a `tool_execution_end` event for the feature's tool (`read` or `fixture_marker`) has `isError` `false`, and the assistant text contains the tool's output. The tool event is required even if the final text looks right.
- Stdout and stderr in the evidence directory do not contain the API key. The harness rewrites a leaked key to `[redacted]` and records that line on stdout.

Mocks are not used. Cursor's model list and completion APIs are the real ones. `PI_OFFLINE=1` on the model-list command only skips Pi's startup network; the completion drives do not set it.

## Cleanup

```sh
.agents/skills/verify/verify.sh cleanup
```

Cleanup deletes `/tmp/pi-cursor-verify/$VERIFY_RUN_ID/run/` (the copied credential, the copied model list, the scratch directory, and the session directory). If `run/pi.pid` still names a live process started by this harness, that pid is killed first. Cleanup does not delete `evidence/`, does not signal processes by name, and does not change `~/.pi/agent`.

After cleanup, `evidence/reply/events.jsonl` from a reply drive must still exist. A cleanup that removes that file has failed.

## Helpers

[`.agents/skills/verify/verify.sh`](verify.sh) is the harness. Invoke it from the repo root:

```sh
export VERIFY_RUN_ID="verify-$(date +%Y%m%dT%H%M%S)"
.agents/skills/verify/verify.sh prepare
.agents/skills/verify/verify.sh doctor
.agents/skills/verify/verify.sh reply
.agents/skills/verify/verify.sh cleanup
test -s "/tmp/pi-cursor-verify/${VERIFY_RUN_ID}/evidence/reply/events.jsonl"
```

Subcommands: `prepare`, `doctor`, `models`, `reply`, `thinking`, `fast`, `tool`, `toolext`, `continue`, `cleanup`.
