# Read a file with a tool

Read a file with a tool lets the model read `marker.txt` through Pi's `read` tool and quote that file in the reply.

## Sub-features

- `tool-read` calls `read` on `marker.txt` and returns the file's text.

## How to get to it (user POV)

- Run Pi with the `read` tool enabled, for example `pi -e <repo> --model cursor/grok-4.6 --tools read`, then ask it to read a file in the current directory.
- In an interactive session whose tools include `read`, ask the same question.

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` printed `auth api_key` and `grok-4.6`.
- The scratch directory is the process working directory. The harness writes `marker.txt` there containing `verify-marker` before the prompt.

- **Ask for the file.** Run `.agents/skills/verify/verify.sh tool`. The command exits 0.
- **See the tool finish.** `evidence/tool/events.jsonl` contains a `tool_execution_end` event with `toolName` `read` and `isError` false.
- **See the contents.** The last assistant text contains `verify-marker`. A reply that contains the marker without a `read` tool event fails this feature.

## Gotchas

- `--tools read` is the whole tool list for this drive. `bash`, `edit`, and `write` are not available. A proof that used a different tool is not this feature.
- If the model answers without calling `read`, the feature fails. Do not drop the tool-event check.
- The scratch file is deleted with the run directory on cleanup. The JSONL under `evidence/tool/` stays.
- This harness does not press Escape and does not prove a cancelled tool call.
