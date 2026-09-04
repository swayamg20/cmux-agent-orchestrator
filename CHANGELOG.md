# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- Automatically create one neutral Active Work task for each newly discovered, uniquely resolved Claude or Codex provider session.
- Reconnect an exact provider conversation to its existing task when its previous cmux surface has disappeared, without creating another run.
- Show the memory-only provider conversation title on its live Work card while keeping automatically written Markdown free of conversation and terminal titles.
- Add a default-on setting to disable creation of new automatic tasks without changing existing tasks or running agents.
- Surface a missing linked Markdown task as an actionable attention item without deleting the binding or recreating the note.
- Surface a conservative stale-working attention signal when structured lifecycle evidence remains Working beyond a configurable inactivity threshold.
- Surface structured or notification-backed finished agent output in Attention for human review without moving the durable task.

### Fixed

- Treat an exact read-back of an ambiguously failed plugin-data save as committed, preventing retries from creating duplicate run records.
- Refuse to reuse a persisted run that belongs to another task, repairing the binding with a new task-owned run while retaining history.
- Ignore task-note vault events until plugin settings finish loading, preventing startup races from throwing before initialization.
- Keep a successful task-note write authoritative while Obsidian's metadata index catches up, preventing Kanban state or run counts from snapping backward.
- Discard cached or in-flight terminal previews when a surface identity, exact provider conversation, or cmux connection changes.
- Invalidate heuristic provider labels when a live cmux UUID changes title, surface type, or working directory, and ignore late preview evidence captured before that change.
- Invalidate short-lived task write-through records on vault change, rename, or delete events so manual Markdown schema or identity edits become authoritative immediately.
- Reconcile a new run count idempotently after a transient Markdown write failure, avoiding both a missing count and a duplicate increment when the vault write outcome is ambiguous.
- Keep newer provider conversation metadata authoritative when overlapping local reads finish out of order, and prevent an in-flight read from undoing an explicit Forget action.
- Retry provider classification on a later refresh when a bounded cmux preview read fails transiently, without repeatedly polling successful but inconclusive shell previews.
- Reject previews that race with plugin unload, and recover scheduler capacity when a preview loader throws synchronously.
- Serialize durable task-note mutations so automatic tracking and manual workflow or run-count writes cannot race, while keeping later writes usable after a failure.
- Keep retrying recoverable automatic-tracking writes without repeating the same failure notice on every reconciliation, while reporting the error again if it recurs after recovery.
- Prevent a new exact provider session that reuses an existing cmux surface from inheriting the previous session's task binding; retain the earlier task and run history while creating a separate automatic task for the new session.
- Let an explicit task attachment win atomically if it races with automatic tracking, instead of allowing background work to replace the user's binding.
- Refuse to detach a task from a stale session card when that cmux surface has since been attached to a different task.
- Refuse to forget a provider conversation from a stale session card when that surface has since been matched to a different conversation.
- Refuse to save a conversation choice from a stale picker when that surface's manual match changed while the picker was open.
- Refuse to save a task choice from a stale picker when the surface's task binding changed while the picker was open.
- Refuse to overwrite a newer Kanban workflow decision from a stale task card.
- Report a failed Detach action as an Obsidian notice without leaking an unhandled promise rejection into the console.
- Preserve the newest proven activity timestamp when an older structured lifecycle event arrives after a terminal preview observation.
- Refresh durable task state when a task note or containing folder is moved or deleted, so stale bindings become visible immediately.
- Restore the workflow selector to its persisted value when a stale or failed card move is rejected.
- Report a stale Focus click safely when the cmux connection is unavailable instead of leaking an unhandled UI rejection.
- Preserve a newly created task and report one explicit partial-success notice if its session attachment cannot be persisted.
- Report a stale Preview click safely when cmux is unavailable instead of leaking an unhandled UI rejection.
- Let a user attach a newly proven provider conversation after cmux reuses an old surface, while retaining the previous task and run history.
- Surface exact provider-conversation replacement as an Attention item when a persisted task binding still points at the reused surface.
- Remove the obsolete v0.1 label from rejected-action messages so the security policy remains accurate across releases.
- Report ribbon and command-palette view failures as notices instead of leaking rejected workspace promises into the console.
- Report connection-test failures from both the main view and settings without leaking rejected promises into the console.

### Security

- Bound the number of persisted binding, run, and provider-session candidates examined during startup, including malformed synced data.
- Re-resolve the complete live cmux tuple and exact provider identity before persisting each automatic binding.
- Fail closed for ambiguous, duplicate, heuristic-only, invalid, shell, and unknown identities, and retain detached run history as a durable no-recreate marker.
- Serialize automatic tracking, normalize canonical provider UUID casing, and derive stable task IDs so refreshes, reloads, source-format differences, and recoverable partial writes cannot duplicate a provider run.
- Discard all conflicting persisted provider-session mappings instead of trusting array order, while preserving the user's durable task notes.
- Ignore saved identity claims whose complete canonical cmux tuple is absent so stale surfaces cannot shadow fresh exact evidence.
- Canonicalize cmux, task, binding, run, and provider UUID casing across CLI, process, Markdown, and plugin-data boundaries so case-only representations cannot bypass uniqueness or produce false missing/focus results.
- Preserve the strongest agreeing identity proof when newer cmux detection and exact local process evidence describe the same provider session.
- Relocate a stale binding only when its complete old cmux target is absent and one unique high-confidence live surface proves the same canonical provider session.
- Require workspace, pane, and surface UUID agreement before projecting a task binding or considering its cmux target present.
- Require high-confidence exact provider identity before treating a same-surface task binding as stale or replaceable.

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
