# Security model

cmux Agent Orchestrator deliberately exposes a smaller capability surface than the host applications it connects.

## Trust boundaries

- Vault Markdown, filenames, frontmatter, cmux titles, terminal text, and notifications are untrusted display data.
- Only hard-coded cmux, process-correlation, open-file inspection, and bounded local Codex metadata operations can cross the process boundary.
- cmux, Claude Code, and Codex retain ownership of terminals and provider session data.
- Plugin settings cannot contain a shell command. The optional binary setting must be an absolute executable path whose basename is `cmux`, and the executable must identify itself through `--version`.
- Socket authentication remains owned by cmux. cmux Agent Orchestrator has no password field and never reads, receives, passes, logs, or persists the cmux Socket Password.

## Process policy

`SafeProcessRunner` uses `child_process.spawn` with `shell: false`, an exact executable, exact argument arrays, deadlines, byte ceilings, ignored stdin, and tracked child lifetimes. Plugin unload sends `SIGTERM` only to short-lived children launched by this plugin.

The provider-title adapter may launch only an executable file named `codex` from the fixed supported local paths, with the exact arguments `app-server --listen stdio://`. It sends only local metadata protocol requests, explicitly disables turn hydration on exact-ID reads, enforces a five-second deadline and byte ceilings, and terminates only the exact child it owns. It never invokes Codex resume, fork, queue, or turn APIs.

The Claude title adapter reads only bounded active-session registries and bounded edge windows of an exact canonical session JSONL under `~/.claude`. It parses only title record types and never writes provider files, installs hooks, or retains raw transcript content.

Automatic identity uses fixed `/bin/ps`, `/usr/bin/grep`, and `/usr/sbin/lsof` paths and argument arrays. The general process inventory buffers only PID, parent/process groups, state, UTC start time, and executable name. For a foreground Claude/Codex candidate, `ps` environment output is piped directly into `grep`; JavaScript receives only a bounded canonical `CMUX_SURFACE_ID`. Codex open-file inspection is constrained to `~/.codex/thread-writer-locks/`. PID identity is checked again after resolution. No command line, arbitrary environment value, unrelated open-file path, or raw provider response is persisted.

No code path launches a shell, arbitrary executable, background daemon, or plugin-originated network request. No code path sends terminal input, clears notifications, closes a surface, changes provider state, or modifies cmux/provider hooks.

Provider conversation metadata never creates identity by repository alone. Automatic identity requires a complete canonical surface tuple plus modern cmux session metadata or exact PID/start/CWD/provider-owned evidence. The inferred mapping is memory-only. With default-on automatic Work tracking, a unique high-confidence provider identity may create a neutral Markdown task and persist its provider session ID inside the machine-scoped binding/run record. The plugin re-resolves the exact live tuple before that write, serializes concurrent reconciliation, and refuses duplicates or ambiguity. A user-selected conversation follows the same target re-resolution and persists only the provider session ID mapping. Manual mappings override automatic evidence; titles and bounded provider responses remain in a capped in-memory cache.

Automatic Work tracking does not copy provider conversation titles, cmux titles, terminal text, previews, notifications, or lifecycle evidence into Markdown. A retained run record prevents a manually detached session from being silently recreated. Disabling the setting stops new automatic task creation; it does not delete existing notes, bindings, or run history.

When cmux blocks a normally launched Obsidian process, cmux Agent Orchestrator provides GUI setup instructions and a connection retry. It never edits cmux configuration, enables Full open access, or restarts cmux.

## Reporting a problem

Keep reports free of terminal transcripts, notification bodies, socket paths, tokens, and provider session files. Include the plugin version, cmux version, the failing allowlisted action, and sanitized error text.
