# Call a Pi tool through Cursor

Call a Pi tool through Cursor lets the model call an active Pi tool mid-turn and use the result in the same reply. The provider forwards every active Pi tool, so the proof needs one built-in tool and one tool no built-in list could contain.

## Sub-features

- `tool-read` calls `read` on `marker.txt` and returns the file's text.
- `tool-extension` calls `fixture_marker`, a tool registered by a second extension, and returns its marker.

## How to get to it (user POV)

- Run Pi with the `read` tool enabled, for example `pi -e <repo> --model cursor/grok-4.6 --tools read`, then ask it to read a file in the current directory.
- Run Pi with an extension that registers a tool, then ask the model to call that tool. Extension tools reach Cursor the same way built-in tools do.
- In an interactive session whose tools include the tool, ask the same question.

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` printed `auth api_key` and `grok-4.6`.
- The scratch directory is the process working directory. For `tool`, the harness writes `marker.txt` there containing `verify-marker` before the prompt. For `toolext`, the harness loads `.agents/skills/verify/fixture-tool.ts` as a second extension.

- **Ask for the file.** Run `.agents/skills/verify/verify.sh tool`. The command exits 0.
- **See the tool finish.** `evidence/tool/events.jsonl` contains a `tool_execution_end` event with `toolName` `read` and `isError` false.
- **See the contents.** The last assistant text contains `verify-marker`. A reply that contains the marker without a `read` tool event fails this feature.
- **Ask for the extension tool.** Run `.agents/skills/verify/verify.sh toolext`. The command exits 0. `evidence/toolext/events.jsonl` contains a `tool_execution_end` event with `toolName` `fixture_marker` and `isError` false, and the last assistant text contains `fixture-marker`.

## Gotchas

- `--tools read` and `--tools fixture_marker` are the whole tool list for their drives. A proof that used a different tool is not this feature.
- The `read` drive alone cannot catch a provider that filters tool names, because `read` is a built-in every filter would keep. `fixture_marker` exists only through the fixture extension, so a name filter drops it and the `toolext` drive fails. Do not skip `toolext` when `tool` passes.
- Cursor calls the argument of path-taking tools `file_path`. The provider renames it to `path` for `read`, `write`, `edit`, `grep`, `find`, and `ls`, so a `read` call that arrives with `file_path` still reaches Pi. The `tool` drive exercises that rename when the model uses Cursor's argument name.
- If the model answers without calling the tool, the feature fails. Do not drop the tool-event check.
- The scratch file is deleted with the run directory on cleanup. The JSONL under `evidence/` stays.
- This harness does not press Escape and does not prove a cancelled tool call.
