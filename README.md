# Agent Cockpit

Agent Cockpit is a desktop-only Obsidian community plugin for observing Claude Code, Codex CLI, and shell sessions that already run inside cmux. Obsidian is the visual control plane and durable task layer. cmux remains the terminal and process owner.

The repository currently targets Obsidian 1.10.x and the installed cmux 0.62.2 command surface. It has no runtime npm dependencies, telemetry, hosted service, or external network requirement.

## What v0.1 provides

- One native Obsidian `ItemView`, opened from the ribbon or command palette.
- Three focused native modes: Work for attention and the durable board, Agent runs for untracked Claude/Codex executions, and cmux for the exact terminal tree.
- All five workflow columns are always visible, including in a brand-new vault with no task notes.
- Canonical workspace, pane, and surface UUIDs from cmux JSON output.
- Conservative Claude, Codex, shell, and unknown detection with evidence and confidence.
- Bounded, memory-only terminal previews loaded once at startup, on explicit refresh, or when requested.
- Exact Focus in cmux with fresh target resolution and a postcondition check.
- Markdown task creation and workflow states: Backlog, Active, Review, Parked, and Done.
- Machine-scoped task-to-surface bindings in plugin data.
- Orphan sessions and stale bindings.
- Clear cmux disconnected, blocked, malformed-output, timeout, and output-limit states.
- One-time GUI onboarding for normal Finder, Dock, and Spotlight launches when cmux rejects external clients.

Agent Cockpit does not host a PTY, resume providers, send terminal input, read complete transcripts, or decide that a task is complete.

## Ownership boundary

| System | Owns |
|---|---|
| cmux | Workspaces, panes, terminal surfaces, process lifetime, and terminal interaction |
| Claude Code and Codex | Provider conversation and session persistence |
| Agent Cockpit | Runtime observations, task associations, workflow presentation, and narrow explicit actions |
| Markdown notes | Human-owned goals, criteria, context, decisions, run summaries, and outcomes |

Runtime state and workflow state are deliberately independent. An idle, missing, errored, or exited surface never moves a task to Done.

Detected, unlinked Claude and Codex runs appear automatically in the Agent runs tab. They do not silently become Markdown notes or Kanban cards. `Track in board` opens a prefilled form, writes one Active durable task note, and attaches that exact run. The row's overflow menu provides Focus in cmux and Attach to existing task.

## Build

Requirements:

- macOS
- Node.js 22 or newer
- npm
- Obsidian desktop 1.10 or newer
- cmux 0.62.2 for the currently tested parser fixtures

```bash
npm install
npm run check
```

`npm run build` creates `main.js` in this repository. For a later manual Obsidian installation, copy `main.js`, `manifest.json`, and `styles.css` into a vault-local `.obsidian/plugins/agent-cockpit/` directory. This repository does not automatically write into a vault.

## Storage

Markdown task notes default to `Agent Cockpit/Tasks/` and contain durable fields only:

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

cmux UUIDs and provider observations do not go into task frontmatter. Plugin `data.json` stores settings and explicit bindings under a one-way hashed machine namespace. Terminal previews, notification bodies, output hashes, first-seen times, and runtime snapshots remain memory-only.

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

Focus refreshes the tree before the command, requires the exact workspace/pane/surface tuple to resolve once, invokes the exact surface, and verifies cmux's authoritative focused workspace/pane/surface tuple afterward. It sends no terminal text and changes no workflow state.

## Refresh and performance

- Topology, notifications, and one bounded display preview per terminal load once when the plugin starts through a two-process queue.
- Clicking Refresh or running the refresh command explicitly repeats that bounded scan.
- There is no repeating topology, notification, or preview timer.
- Workspace CWD metadata is cached for 30 seconds across closely spaced manual refreshes.
- Previews load during the one-time startup scan, when a row is expanded, and during an explicit global Refresh; they allow at most two concurrent reads.
- Displayed previews remain configurable up to 80 lines with a 16 KiB default in-memory ceiling.
- Only terminals still lacking a provider after the display preview receive one additional provider-only read, bounded to 500 lines and 64 KiB. The deeper text is discarded after detection and is never displayed or persisted.
- Every read-screen process retains a 96 KiB raw output ceiling.
- Unloading the plugin terminates only its own short-lived cmux CLI children.

## Runtime evidence

Each runtime assessment includes a state, source, confidence, observation time, and explanation. In cmux 0.62.2, surface presence and terminal text do not prove provider lifecycle state. Consequently, many sessions correctly show `Runtime: Unknown` even after provider detection identifies Claude or Codex. Distinctive provider TUI markers can classify the provider with explicit low, medium, or high confidence, but never prove lifecycle state or completion.

- Unread structured notifications can support medium-confidence Error or Needs input.
- Generic words such as `approval` or `confirm` in terminal prose never assert Needs input.
- A changed bounded preview can support low-confidence Running.
- A long-observed unchanged preview can support low-confidence Idle.
- A missing linked surface creates an attention item but does not prove provider completion.
- Provider session IDs remain absent unless a future structured source proves them.

## Tests

```bash
npm run lint
npm test
npm run build
```

Sanitized fixtures under `tests/fixtures/cmux-0.62.2/` preserve the installed JSON shapes without copying terminal output, notification content, paths, or live UUIDs.

A read-only local smoke test is opt-in:

```bash
AGENT_COCKPIT_LIVE_CMUX=1 npm test -- tests/smoke/cmux.live.test.ts
```

It probes capabilities, reads topology and notifications, validates canonical UUIDs, and reads three lines from one selected terminal. It never focuses a surface or sends input.

## Normal-launch connection setup

cmux defaults to `access_mode: cmuxOnly`, which authorizes only processes descended from cmux terminals. When a normally launched Obsidian process is rejected, Agent Cockpit presents an in-product setup panel instead of requiring Obsidian to be started from a terminal.

The recommended setup is cmux Settings → Automation → Socket Control Mode → Password mode, with the Socket Password set inside cmux. The cmux CLI consumes its own saved password; Agent Cockpit never reads, receives, passes, logs, or persists it. Automation mode is supported as a broader same-macOS-user alternative. Full open access is never recommended.

The setup panel can retest the connection and then load the complete cockpit. Agent Cockpit does not change cmux settings, restart the listener or app, install hooks, or introduce a relay daemon. If the installed cmux build retains its previous socket policy, the UI explains that cmux may need a user-controlled restart after active sessions are safe.

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
  runtime/      previews, runtime evidence, and attention
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

Repository-local tests cannot prove that Obsidian loads the bundle, renders both themes, persists through an Obsidian reload, or transfers macOS focus to the correct cmux window. Those checks require a separately approved vault installation and, for the current machine, a safely scheduled cmux Automation-mode change. The final focus test should target the development surface and must not send input.
