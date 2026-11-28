# Changelog

## [Unreleased]

Third-party models report an estimated per-turn cost: Kimi, GLM, and DeepSeek models are priced at the API list prices Cursor publishes, instead of falling back to $0.

Changed how releases are cut: `mise run release` dates the Unreleased entry and tags after the local checks, and the tag triggers a workflow that reruns the checks on the tag, installs the tag the way Pi installs the package, and creates the GitHub Release.

## [0.0.1] - 2026-11-28

First release. The provider lists Cursor models from the account's catalog, keeps one local agent for the session and streams its replies, forwards Pi's active tools to the model, maps thinking levels onto each model's reasoning parameter, sends `fast=false` when the catalog lists it, and reports billed cost per turn. Extensions can run one-off completions through the `pi-provider-cursor/side-request` export.
