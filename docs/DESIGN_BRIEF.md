# cmux Agent Orchestrator v0.1 Design Brief

## Feature summary

cmux Agent Orchestrator is a production-ready desktop Obsidian view for one developer supervising roughly two dozen Claude Code, Codex, and shell surfaces owned by cmux. It connects volatile runtime observations to durable task notes without hosting terminals or changing provider session ownership.

## Primary user action

Recognize the session or task that needs human judgment and focus its exact existing cmux surface with one explicit action.

## Design direction

- Restrained, host-theme-adaptive color strategy.
- Scene: a focused developer scans Obsidian on a large desktop display while multiple background agents run; healthy work stays quiet and exceptions are immediately legible.
- Anchors: Obsidian for host-native behavior, Linear for compact task scanning, Activity Monitor for understandable runtime hierarchy, and Raycast for explicit actions.
- Approved visual direction: one restrained native ItemView with three purposeful modes—Work, Agent runs, and cmux—so durable work, untracked executions, and raw terminal topology never compete in one stacked control panel.

## Scope

Production-ready desktop plugin surface covering Needs My Attention, Work Kanban, Live Sessions, settings, empty/loading/error states, and the explicit focus/task-linking flows. Mobile and embedded terminal interaction are excluded.

## Layout strategy

The header establishes connection health and refresh without dominating. A compact native tab bar separates the modes. Work keeps attention above the five-column board; Agent runs gives untracked executions a dedicated scan-and-track list; cmux reserves the full canvas for filters and exact runtime inspection.

## Key states

- Connecting, connected, access blocked, cmux closed, malformed response, and stale snapshot.
- Empty attention queue, unread notification, input suspected, error suspected, review suggested, linked surface missing, and partial source failure.
- Empty task folder, task creation, linked and orphan sessions, stale binding, and every workflow column.
- Preview idle, loading, loaded, truncated, timed out, and unavailable.
- Focus resolving, succeeded, stale target, ambiguous target, command failure, and unverifiable postcondition.

## Interaction model

The three modes use an accessible tablist with explicit hover, focus, selected, Home/End, and arrow-key behavior. Rows expand inline inside the active mode. Preview loading is explicit or visibility-triggered and never global. Kanban supports drag-and-drop plus an accessible workflow selector. Focus re-resolves canonical UUIDs before invoking cmux. Task creation and attachment use native Obsidian modals and suggestions.

## Content requirements

Use honest labels such as `Last observed activity`, `Last visible input`, `Session evidence`, `State unknown`, and `Access blocked`. Do not use `Done` for agent execution or imply that unchanged output proves completion.

## Visual probe decision

Two probes were generated. The implementation carries forward the first probe's quiet, cardless Obsidian list and the second probe's inline expanded evidence and preview. Fake vault contents, hard-coded themes, raster UI, and invented provider data are not implementation assets.

## Open questions

The exact macOS foreground behavior of `cmux focus-panel` remains subject to a controlled local smoke test. If cmux selection and app activation differ, they will remain separate explicit operations.
