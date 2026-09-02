# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [0.2.0] - 2026-09-03

### Added

- Automatically show distinct Codex and Claude conversation titles after exact modern-cmux or local process/session correlation, with a manual override fallback.
- Load bounded local Codex app-server metadata and Claude title records through replaceable provider-source interfaces.
- Persist only user-selected, machine-scoped surface-to-provider-session-ID mappings; keep automatic mappings, titles, and bounded source data in memory.
- Feature-detect modern cmux `list-agents` lifecycle records while retaining a read-only fallback for cmux 0.62.2.
- Represent provider Idle separately from working, waiting, review-ready output, and durable task completion.

### Security

- Fail closed on ambiguous provider identity, duplicate conversation assignments, changed cmux targets, and CWD mismatches.
- Explicitly disable Codex turn hydration and bound provider subprocess time, output, file reads, concurrency, and cache size.
- Require one foreground process, one canonical cmux surface, PID/start/CWD agreement, and exactly one root provider session; discard races and ambiguity.

## [0.1.1] - 2026-08-31

### Fixed

- Remove the redundant platform name from the Community directory description.
- Limit durable-task discovery to the configured task folder instead of enumerating the whole vault.
- Replace partially supported and over-broad CSS overrides while preserving sticky navigation and reduced-motion behavior.
- Expose searchable settings through the 1.13 declarative settings API while retaining the legacy settings-tab fallback.
- Replace the deprecated destructive-action button API with its current equivalent.

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
