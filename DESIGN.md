# cmux Agent Orchestrator Design System

## Theme

cmux Agent Orchestrator inherits the active Obsidian theme. It does not impose a light or dark theme and does not ship a branded palette. Surfaces, borders, text, controls, and focus treatment use Obsidian CSS variables.

## Color strategy

Restrained. Neutral structure carries the interface. Accent and semantic colors appear only for selection, connection health, runtime evidence, attention severity, success, and failure. Every colored state also includes a text label or icon.

## Typography

Use Obsidian's interface font and native text sizes. Establish hierarchy through weight, contrast, and spacing instead of display typography. Terminal previews use Obsidian's monospace font and remain secondary to task and evidence labels.

## Layout

The primary `ItemView` uses three clear modes instead of stacking every concern into one control panel. Work contains compact attention plus workflow totals and opens detailed planning in a second, dedicated native board view. Agent runs contains the complete confidently detected Claude and Codex run inventory: linked runs open their task, while unlinked runs expose one visible `Track in board` action; Focus, Attach, and Detach remain in a secondary menu. cmux owns the exact workspace, pane, and surface hierarchy. The board always renders Backlog, Active, Review, Parked, and Done—even when empty—and bounds horizontal board movement separately from each column's vertical task scroll. Session rows reveal evidence and bounded previews inline only when requested.

Use a 4 px spacing base with compact operational rhythm. Components adapt to their pane width using container queries where supported and conservative media-query fallbacks.

## Components

- Connection health is compact text plus an icon, never a hero metric.
- A blocked normal launch expands into a one-time native setup panel with password-mode guidance, a retry action, and explicit security boundaries.
- Session badges label the execution phase, evidence confidence, and coverage in accessible text. `State unknown` is preferable to a guessed lifecycle state.
- Mode tabs have explicit hover, keyboard-focus, and selected states with arrow-key navigation.
- The dedicated board supports context search, live-run filtering, drag-and-drop, keyboard-accessible workflow selectors, and explicit no-live task selection without turning absence into an automatic workflow decision.
- Session and attention rows reveal secondary actions progressively.
- Terminal preview is read-only, bounded, selectable, and visually subdued.
- Buttons use Obsidian native classes and variables with explicit focus-visible treatment.
- Destructive or disruptive actions remain absent from the current release.

## Motion

Motion communicates expansion, refresh, and state change only. Transitions are short and disabled or reduced under `prefers-reduced-motion`.
