# Agent Cockpit

## Register

product

## Users

Agent Cockpit is for a developer operating many Claude Code and Codex CLI sessions inside cmux while using Obsidian as the durable place for tasks, decisions, and outcomes. The user is frequently context-switching and needs to identify the small number of sessions that require human judgment without losing the larger task history.

## Product Purpose

Agent Cockpit makes Obsidian a visual control plane for existing cmux sessions. It projects bounded evidence about surfaces and agents, connects temporary sessions to durable work items, and offers narrow explicit actions without becoming a terminal host, agent platform, transcript store, or autonomous orchestrator.

Success means the user can launch Obsidian normally, open one native view, see what needs attention, understand the evidence behind each status, move between task workflow and live runtime context, and focus the exact existing cmux surface safely.

## Brand Personality

Calm, precise, operational. The interface should feel like a quiet command desk embedded in Obsidian: dense enough for serious work, restrained enough that healthy sessions disappear into the background, and explicit whenever evidence is uncertain.

## Anti-references

- A cyberpunk terminal or embedded terminal emulator.
- A wall of metrics or Grafana-style monitoring dashboard.
- A generic SaaS card grid with oversized metrics and decorative charts.
- A standalone branded web application that competes with Obsidian.
- An interface that makes every running agent look urgent.
- A status system that presents heuristics as confirmed facts.

## Design Principles

1. Attention before inventory: surface the few items requiring judgment before showing the full runtime tree.
2. Evidence before confidence: every runtime label explains where it came from and how certain it is.
3. Progressive disclosure: separate Work, Agent runs, and cmux into focused modes, then reveal terminal previews, canonical IDs, and diagnostics only inside the relevant mode and on request.
4. Task state is human-owned: runtime observations never silently complete durable work.
5. Native over novel: use Obsidian conventions, theme variables, keyboard behavior, and interaction patterns wherever possible.
6. Normal launch is mandatory: terminal-launched Obsidian is a development fallback, never the published user journey.

## Accessibility & Inclusion

Target WCAG AA contrast, full keyboard access, visible focus, reduced-motion support, and status communication that never relies on color alone. Controls remain usable with long repository names, narrow panes, zoomed text, and either Obsidian theme.
