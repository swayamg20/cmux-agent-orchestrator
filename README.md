# cmux Agent Orchestrator

cmux Agent Orchestrator is a desktop-only Obsidian community plugin for coordinating Claude Code and Codex CLI sessions that already run inside cmux. It is a human-in-the-loop orchestration layer: Obsidian owns durable work context, cmux remains the terminal and process owner, and each provider retains its own session state.

The repository currently targets Obsidian 1.10.x and the installed cmux 0.62.2 command surface. It has no runtime npm dependencies, telemetry, hosted service, or external network requirement.

## Screenshots

### Work

![Work view with attention signals and the durable task board](screenshots/work.png)

### Agent runs

![Detected Claude and Codex runs ready to track on the work board](screenshots/agent-runs.png)

### cmux

![Live cmux workspace, pane, and terminal-surface hierarchy](screenshots/cmux.png)

## What v0.1 provides

- One native Obsidian `ItemView`, opened from the ribbon or command palette.
- Three focused native modes: Work for attention and the durable board, Agent runs for untracked Claude/Codex executions, and cmux for the exact terminal tree.
- All five workflow columns are always visible, including in a brand-new vault with no task notes.
- Canonical workspace, pane, and surface UUIDs from cmux JSON output.
- Conservative Claude, Codex, shell, and unknown detection with evidence and confidence.
- Bounded, memory-only terminal previews loaded only when a session is expanded or explicitly requested.
- Exact Focus in cmux with fresh target resolution and bounded postcondition retries.
- Markdown task creation and workflow states: Backlog, Active, Review, Parked, and Done.
- Machine-scoped task, run-history, and surface bindings in schema-v2 plugin data.
- Orphan sessions and stale bindings.
- Clear cmux disconnected, blocked, malformed-output, timeout, and output-limit states.
- One-time GUI onboarding for normal Finder, Dock, and Spotlight launches when cmux rejects external clients.

cmux Agent Orchestrator does not host a PTY, autonomously resume providers, send terminal input, read complete transcripts, or decide that a task is complete.

## Ownership boundary

| System | Owns |
|---|---|
| cmux | Workspaces, panes, terminal surfaces, process lifetime, and terminal interaction |
| Claude Code and Codex | Provider conversation and session persistence |
| cmux Agent Orchestrator | Runtime observations, task associations, human-directed coordination, and narrow explicit actions |
| Markdown notes | Human-owned goals, criteria, context, decisions, run summaries, and outcomes |

Agent evidence and workflow state are deliberately independent. A quiet, missing, errored, or ended session never moves a task to Done.

Detected, unlinked Claude and Codex runs appear automatically in the Agent runs tab. They do not silently become Markdown notes or Kanban cards. `Track in board` opens a prefilled form, writes one Active durable task note, and attaches that exact run. The row's overflow menu provides Focus in cmux and Attach to existing task.

## Build

Requirements:

- macOS
- Node.js 22.13 or newer
- npm
- Obsidian desktop 1.10 or newer
- cmux 0.62.2 for the currently tested parser fixtures

```bash
npm install
npm run check
```

`npm run build` creates `main.js` in this repository. For a manual Obsidian installation, copy `main.js`, `manifest.json`, and `styles.css` into a vault-local `.obsidian/plugins/cmux-agent-orchestrator/` directory. This repository does not automatically write into a vault.

Maintainers should follow the complete [release procedure](docs/RELEASING.md), including the normal macOS launch and vault-local safety checks, before creating a tag.

## Storage

Markdown task notes default to `Agent Cockpit/Tasks/` and contain durable fields only. The pre-release folder and frontmatter marker remain stable so existing task notes continue to load after the public rename:

```yaml
---
agent-cockpit: task
schema-version: 1
task-id: stable-uuid
title: Human-readable task title
workflow-status: active
priority: normal
repository:
branch:
worktree:
run-count: 0
created-at:
updated-at:
---
```

cmux UUIDs and provider observations do not go into task frontmatter. Plugin `data.json` schema version 2 stores settings, explicit surface bindings, and durable run relationships under a one-way hashed machine namespace. Existing schema-v1 bindings migrate in memory and are written as v2 on the next plugin-data mutation. Terminal previews, notification bodies, evidence ledgers, output fingerprints, and source-health snapshots remain memory-only.

A task may own several runs and several currently attached surfaces. Each binding has its own canonical binding ID and run ID. Reattaching the same surface/provider run reuses that run; a different provider is recorded as a handoff; uncertain same-provider relationships remain explicitly `unknown` rather than being invented as a resume or fork.

## cmux transport

The `CmuxTransport` interface keeps CLI snapshots replaceable by a future socket/event transport. `CliCmuxTransport` invokes only an executable file named `cmux`, with `spawn` and exact argument arrays. It never uses `exec`, `sh -c`, command interpolation, or text from Markdown.

Read-only allowlist:

```text
cmux --version
cmux --json capabilities
cmux --json --id-format uuids tree --all
cmux --json --id-format uuids list-workspaces
cmux --json --id-format uuids list-notifications
cmux --json --id-format uuids identify --no-caller
cmux --id-format uuids read-screen --workspace <uuid> --surface <uuid> --lines <1..500>
```

Explicit user-initiated selection:

```text
cmux focus-panel --panel <surface-uuid> --workspace <workspace-uuid>
```

Focus refreshes the tree before the command, requires the exact workspace/pane/surface tuple to resolve once, invokes the exact surface, and verifies cmux's authoritative focused workspace/pane/surface tuple afterward. Verification is retried only inside a bounded 500 ms window so normal cmux selection propagation is not reported as an immediate false negative. It sends no terminal text and changes no workflow state.

## Refresh and performance

- Startup probes cmux once, then loads topology and notifications in parallel. A warm global Refresh invokes only those two read-only sources.
- Global Refresh never reads terminal previews. Concurrent refresh requests coalesce, stale generations are ignored, and a notification failure does not discard a healthy topology snapshot.
- There is no repeating topology, notification, or preview timer.
- Workspace CWD metadata is cached for 30 seconds across closely spaced manual refreshes.
- Display previews load only when a row is expanded or the user presses Load/Refresh preview; they allow at most two concurrent reads.
- Displayed previews remain configurable up to 80 lines with a 16 KiB default ceiling and live in a 20-entry, 1 MiB in-memory LRU.
- A newly discovered terminal that still lacks provider evidence may receive one provider-only background read, bounded to 500 lines and 64 KiB with two-process concurrency. That deeper text is discarded immediately after classification, is never displayed, and is not repeated by later global refreshes.
- Every read-screen process retains a 96 KiB raw output ceiling.
- Unloading the plugin terminates only its own short-lived cmux CLI children.

## Agent evidence

Each session projects separate dimensions: surface presence, agent presence, execution phase, recent activity, evidence coverage, source, confidence, and explanation. This avoids compressing unrelated facts into a misleading single runtime badge.

- In cmux 0.62.2, topology proves only that a canonical surface exists. It does not prove an attached agent, a live turn, or completion.
- Unread cmux notifications can support medium-confidence `Needs input`, `Error reported`, or `Review output`.
- A changed on-demand preview records low-confidence recent activity such as reading, editing, or command output, but leaves execution phase `State unknown`.
- Generic words such as `approval` or `confirm` in terminal prose never assert `Needs input`.
- A missing linked surface creates an attention item but does not prove provider completion.
- Provider session IDs remain absent unless a future structured source proves them.
- Source health is independent: topology, notifications, and provider lifecycle each report fresh, stale, or unavailable. On the installed cmux 0.62.2 surface, structured lifecycle coverage is honestly `unavailable`.

The in-memory evidence ledger is bounded to 32 entries per session and 2,048 total. The deterministic reducer ranks structured lifecycle evidence above notifications, preview heuristics, and surface presence. No reducer transition changes Markdown workflow state.

## Tests

```bash
npm run lint
npm test
npm run build
```

Sanitized fixtures under `tests/fixtures/cmux-0.62.2/` preserve the installed JSON shapes without copying terminal output, notification content, paths, or live UUIDs.

A read-only local smoke test is opt-in:

```bash
CMUX_AGENT_ORCHESTRATOR_LIVE_CMUX=1 npm test -- tests/smoke/cmux.live.test.ts
```

It probes capabilities, reads topology and notifications, validates canonical UUIDs, and reads three lines from one selected terminal. It never focuses a surface or sends input.

## Normal-launch connection setup

cmux defaults to `access_mode: cmuxOnly`, which authorizes only processes descended from cmux terminals. When a normally launched Obsidian process is rejected, cmux Agent Orchestrator presents an in-product setup panel instead of requiring Obsidian to be started from a terminal.

The recommended setup is cmux Settings → Automation → Socket Control Mode → Password mode, with the Socket Password set inside cmux. The cmux CLI consumes its own saved password; cmux Agent Orchestrator never reads, receives, passes, logs, or persists it. Automation mode is supported as a broader same-macOS-user alternative. Full open access is never recommended.

The setup panel can retest the connection and then load the complete orchestrator. cmux Agent Orchestrator does not change cmux settings, restart the listener or app, install hooks, or introduce a relay daemon. If the installed cmux build retains its previous socket policy, the UI explains that cmux may need a user-controlled restart after active sessions are safe.

## System access and privacy

The plugin accesses one resource outside the Obsidian vault: the local `cmux` executable and the running cmux instance it connects to. That access is required to discover workspaces, panes, terminal surfaces, notifications, and bounded terminal previews, and to focus an exact surface after an explicit click. It does not read Claude or Codex session files, make network requests, collect telemetry, or transmit vault and terminal data.

## Security limits

- Desktop-only manifest.
- No arbitrary command setting or general terminal executor.
- Canonical UUID validation for every cmux target.
- User-controlled Markdown is display data only and is never executed.
- Untrusted titles, paths, notifications, and previews are inserted as text, not HTML.
- No socket passwords, tokens, API keys, or complete transcripts are read from cmux settings or persisted.
- No provider queue, resume, fork, interrupt, close, kill, delete, or hook action exists in v0.1.
- No `pkill`, broad process matching, or provider session-file deletion.

## Repository layout

```text
src/
  app/          orchestration controller
  cmux/         transport, subprocess runner, commands, and decoders
  agents/       conservative provider adapters
  evidence/     bounded evidence ledger, event types, and deterministic reducer
  runtime/      preview cache/scheduler, session projection, and attention
  state/        typed observable store
  tasks/        Markdown schema, template, and repository
  bindings/     machine-scoped task/session mappings
  actions/      allowlist, validators, and exact focus action
  security/     shared canonical-identity validation
  views/        unified ItemView, automatic run inbox, board, and cmux explorer
  components/   session/task rendering and native modals
  settings/     validated plugin settings
tests/
  fixtures/     sanitized cmux 0.62.2 output shapes
```

## Still requiring manual verification

Repository-local tests cannot prove that Obsidian renders both themes, preserves hover/focus under every third-party theme, persists through an actual Obsidian reload, or transfers macOS focus to the intended cmux window. Those checks require the vault-local build and a controlled manual click. Password mode already supports normal Finder, Dock, and Spotlight launches without passing the socket password through cmux Agent Orchestrator. The final focus test should target a user-approved development surface and must not send input.

## Pre-release migration

The public plugin ID is `cmux-agent-orchestrator`. On first load, it may copy valid bounded data from the former vault-local `agent-cockpit/data.json` into its own plugin folder when no current data exists. The importer never deletes or edits the legacy file, and current plugin data always wins.

## License

[MIT](LICENSE)
