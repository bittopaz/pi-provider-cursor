# pi-cursor-sdk

Pi provider that calls a Cursor model and returns the text.

## Use it

Set `CURSOR_API_KEY`, or run `/login` and choose Cursor. Load this directory as a Pi extension and select a `cursor/` model.

```sh
pi -e . --model cursor/grok-4.6
```

Each turn sends the current Pi transcript and creates a new local Cursor agent. The provider does not resume an earlier agent. `Agent.create` is called with `tools: []` and `local.fs` set to an empty in-memory tree, so the model has no Cursor tools and does not receive the host workspace.

`Cursor.models.list` fills the model list. If that call fails, or there is no API key, the list is the single model `grok-4.6`. Catalog entries do not expand fast or context-window aliases. The SDK does not report a context window, so every model uses 128000 input tokens and 16384 output tokens.

Image parts and earlier thinking text are omitted. Models are listed with reasoning off, because this provider does not send a Pi thinking level. The turn's agent files are deleted when the turn ends.

## Develop

```sh
npm test
npm run typecheck
npm run build
```

Node 24.22.3 or newer on the 24 line, or Node 26.13.1 or newer. The Cursor SDK dependency is `@cursor/sdk` 1.4.1.
