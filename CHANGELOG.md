# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-08-31

### Fixed

- Remove the redundant platform name from the Community directory description.
- Limit durable-task discovery to the configured task folder instead of enumerating the whole vault.
- Replace partially supported and over-broad CSS overrides while preserving sticky navigation and reduced-motion behavior.

### Security

- Generate signed GitHub artifact provenance attestations for every release asset.

## [0.1.0] - 2026-08-25

### Added

- Observe the canonical cmux workspace, pane, and terminal-surface hierarchy from a native Obsidian view.
- Detect Claude Code and Codex sessions conservatively with explicit evidence and confidence.
- Track temporary agent runs as durable Markdown work items across Backlog, Active, Review, Parked, and Done.
- Load bounded, memory-only terminal previews on demand and focus an exact existing cmux surface safely.
- Guide normal macOS Obsidian launches through cmux password or automation access without handling socket credentials.
- Preserve pre-release Agent Cockpit settings and task associations through a one-time, non-destructive data import.

### Security

- Restrict process execution to allowlisted cmux commands using exact argument arrays and `spawn` with `shell: false`.
- Keep terminal previews, notifications, provider evidence, and lifecycle snapshots out of the vault.
