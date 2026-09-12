# Roadmap

cmux Agent Orchestrator is moving from a trustworthy observation and work-tracking layer toward a safe command-and-orchestration surface. The milestones below separate near-term reliability work from the larger control boundary introduced by terminal input and an optional AI coordinator.

The roadmap describes planned behavior, not the current release. See the [README](../README.md) for shipped capabilities and the [changelog](../CHANGELOG.md) for completed changes.

## Current release: 0.4.0

The current public release observes existing cmux sessions, correlates exact Claude Code and Codex conversations when evidence permits, tracks durable Markdown work, and offers guarded workflow suggestions. It does not send terminal input or run an autonomous coordinator.

## Next release: 0.5.0 — stabilization

Version 0.5.0 makes the current observation and work-management experience dependable before the plugin gains command authority.

Planned outcomes:

- Current and legacy cmux lifecycle compatibility.
- A dedicated, stable Work board with bounded independent scrolling.
- Compact, actionable attention presentation.
- Reliable hover, keyboard-focus, and narrow-pane behavior.
- One-click review that performs a guarded workflow transition, focuses the exact surface, and brings cmux forward.
- No terminal input, autonomous coordinator, or automatic completion.

The complete scope and release gates are in the [0.5.0 plan](plans/v0.5.0.md).

## Major milestone: 1.0.0 — command and orchestration

Version 1.0.0 turns the plugin into an active orchestration surface while preserving exact targeting and human authority.

Planned outcomes:

- Send an instruction to one verified Claude Code or Codex session.
- Combine instruction delivery with exact cmux focus.
- Drive safe workflow changes from deterministic, fresh evidence.
- Offer an optional, bounded AI coordinator that is off by default.
- Preserve explicit approval for consequential actions and every transition to Done.
- Migrate existing tasks and bindings without duplication or loss.

The complete product, architecture, and safety contract is in the [1.0.0 plan](plans/v1.0.0.md).

## Sequencing policy

- Implement and verify 0.5.0 before adding terminal-input authority.
- Develop 1.0.0 through small, reviewable commits and local test builds rather than one undifferentiated change.
- Keep shipped behavior, planned behavior, and experiments clearly separated in public documentation.
- Fail closed whenever cmux identity, provider identity, lifecycle state, or delivery outcome is ambiguous.
