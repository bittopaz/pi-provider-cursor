# Send a second message

Send a second message gives `cursor/grok-4.6` two prompts in one Pi process, and the second reply uses what the first prompt said.

## Sub-features

- `continue-second-message` answers the second prompt with the code word from the first prompt.

## How to get to it (user POV)

- Start `pi -e <repo> --model cursor/grok-4.6`, send `The code word is amber.`, then send `Reply with the code word only.`
- Run one print-mode process with both sentences as separate messages.

## Driving it with verify.sh

Preconditions:

- `verify.sh doctor` printed `auth api_key` and `grok-4.6`.
- Tools stay off. Both prompts go to the same `verify.sh continue` process.

- **Send both prompts.** Run `.agents/skills/verify/verify.sh continue`. The command exits 0.
- **See both user messages.** `evidence/continue/events.jsonl` records `The code word is amber.` and then `Reply with the code word only.` as user messages, in that order.
- **See the second reply.** There are two assistant replies. The second assistant text contains `amber`.

## Gotchas

- `--no-session` means a later Pi process does not resume this exchange. The second message has to be in the same process. A new process is a different feature and is not a pass for this one.
- This drive bills two completions. Do not run it after a drive whose reported cost already exceeded $5.
- The first reply does not need to contain `amber`. The second reply does.
