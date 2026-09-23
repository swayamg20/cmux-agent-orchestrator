# Support and feedback

cmux Agent Orchestrator is maintained as an open-source project. Support is best effort and has no guaranteed response time.

## Choose the right channel

- [Report a bug](https://github.com/swayamg20/cmux-agent-orchestrator/issues/new?template=bug.yml) when existing behavior is broken or differs from the documented behavior.
- [Report a compatibility problem](https://github.com/swayamg20/cmux-agent-orchestrator/issues/new?template=compatibility.yml) when a particular cmux, Obsidian, Claude Code, or Codex version combination fails.
- [Suggest an idea](https://github.com/swayamg20/cmux-agent-orchestrator/discussions/new?category=ideas) for a new capability or workflow.
- [Ask a question](https://github.com/swayamg20/cmux-agent-orchestrator/discussions/new?category=q-a) for usage and setup help.
- [Report a security vulnerability privately](https://github.com/swayamg20/cmux-agent-orchestrator/security/advisories/new). Do not open a public issue for a vulnerability.

Before opening a report, update to the latest plugin and cmux releases, review existing issues or discussions, and confirm the problem still occurs.

## Privacy-safe diagnostics

Run **cmux Agent Orchestrator: Open help and feedback** from the command palette, or open **Help and feedback** in the plugin settings. The diagnostics preview is generated on demand from an explicit allowlist. Nothing is transmitted automatically.

The preview contains versions, connection and source-health states, aggregate inventory counts, and relevant behavior settings. It excludes filesystem paths, executable paths, workspace and session identifiers, titles, terminal output, transcripts, prompts, task content, notifications, error text, environment variables, and secrets.

Review the complete preview before selecting **Copy diagnostics** and before sharing it. If anything looks private, remove it and mention the omission in the report.

## Useful report details

Include:

- The plugin, Obsidian, and cmux versions.
- Whether the affected provider is Claude Code, Codex, or neither.
- The smallest reproducible sequence.
- What you expected and what you observed.
- The reviewed privacy-safe diagnostics, when relevant.

Do not include:

- Terminal transcripts, prompts, or generated output.
- Task-note content or conversation titles.
- Filesystem, vault, repository, socket, or executable paths.
- Workspace, pane, surface, task, run, or provider session identifiers.
- Credentials, tokens, environment variables, or provider session files.
