# Changelog

## [0.0.1] - 2026-11-28

First release. The provider lists Cursor models from the account's catalog, keeps one local agent for the session and streams its replies, forwards Pi's active tools to the model, maps thinking levels onto each model's reasoning parameter, sends `fast=false` when the catalog lists it, and reports billed cost per turn. Extensions can run one-off completions through the `pi-provider-cursor/side-request` export.
