# List Cursor models

List Cursor models prints the Cursor rows Pi can select, including context size, output limit, thinking, and image support.

## Sub-features

- `models-saved` prints the saved catalog for the copied API key.
- `models-fallback` prints only `grok-4.6` when no saved catalog is loaded.

## How to get to it (user POV)

- Run `pi -e <repo> --list-models cursor/`.
- In the interactive model picker, choose the Cursor provider.

## Driving it with verify.sh

Preconditions:

- `verify.sh prepare` has run for this `VERIFY_RUN_ID`.
- Doctor has a credential. The saved-catalog path also needs `catalog=remembered` from prepare.

- **Print the table.** Run `.agents/skills/verify/verify.sh models`. The command exits 0 and writes `evidence/models.txt`. The header begins with `provider` and `model`. Every data row has provider `cursor`, max-out `16.4K`, and images `yes`.
- **Saved catalog.** When prepare printed `catalog=remembered`, the table has more than one row, `grok-4.6` is `256K` with thinking `yes`, and any of these ids use the context in this list: `composer-2.5`, `default`, `glm-5.2`, `kimi-k2.7-code`, and `kimi-k3` are `200K`; `grok-4.5` and `grok-4.6` are `256K`; `grok-4.7` is `500K`; `glm-5p3` and `glm-5p3-flash` are `1M`; `deepseek-v41-flash-1017` is `1.0M`.
- **Fallback.** When prepare printed `catalog=fallback`, the only data row is `cursor grok-4.6 256K 16.4K no yes`.
- **Proof.** `evidence/doctor.txt` contains `auth api_key` and the same `models=` summary as the table assertion.

## Gotchas

- `--list-models` reads the saved catalog. It does not refresh from Cursor. A stale or missing `cursor-sdk-model-list.json` cannot be repaired by listing again.
- A saved list copied without the matching API key publishes the fallback row. Doctor treats that as a failure when prepare selected `catalog=remembered`. The fallback row also appears when the saved list is missing, fails its version or key-fingerprint check, is not a valid model list, or when a live refresh returns no models.
- Extra model ids are allowed. A known id with a different context value is a failure.
- Thinking `yes` or `no` follows the saved catalog, except the fallback row, which is thinking `no`.
