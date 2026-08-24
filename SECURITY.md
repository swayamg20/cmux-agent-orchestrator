# Security model

Agent Cockpit deliberately exposes a smaller capability surface than the host applications it connects.

## Trust boundaries

- Vault Markdown, filenames, frontmatter, cmux titles, terminal text, and notifications are untrusted display data.
- Only hard-coded cmux operations can cross the process boundary.
- cmux, Claude Code, and Codex retain ownership of terminals and provider session data.
- Plugin settings cannot contain a shell command. The optional binary setting must be an absolute executable path whose basename is `cmux`, and the executable must identify itself through `--version`.
- Socket authentication remains owned by cmux. Agent Cockpit has no password field and never reads, receives, passes, logs, or persists the cmux Socket Password.

## v0.1 process policy

`SafeProcessRunner` uses `child_process.spawn` with `shell: false`, an exact executable, exact argument arrays, deadlines, byte ceilings, ignored stdin, and tracked child lifetimes. Plugin unload sends `SIGTERM` only to cmux CLI children launched by this plugin.

No code path launches a shell, provider CLI, arbitrary executable, background daemon, or network request. No code path sends terminal input, clears notifications, closes a surface, or modifies cmux/provider hooks.

When cmux blocks a normally launched Obsidian process, Agent Cockpit provides GUI setup instructions and a connection retry. It never edits cmux configuration, enables Full open access, or restarts cmux.

## Reporting a problem

Keep reports free of terminal transcripts, notification bodies, socket paths, tokens, and provider session files. Include the plugin version, cmux version, the failing allowlisted action, and sanitized error text.
