# Release procedure

This project ships as an Obsidian desktop plugin. A release must preserve cmux process ownership and must not send input to, resume, interrupt, or close any existing agent session during verification.

## 1. Preflight

- Work from a clean release branch.
- Confirm the public display name, manifest ID, package name, repository URL, and license before the first public release. Treat the manifest ID as permanent after publication.
- Confirm `manifest.json`, `package.json`, and `versions.json` use the same three-part version.
- Confirm the manifest ID matches the release asset folder name.

## 2. Automated verification

Run from the repository root:

```bash
npm ci
npm run check
CMUX_AGENT_ORCHESTRATOR_LIVE_CMUX=1 npm test -- tests/smoke/cmux.live.test.ts
npm run validate:release -- --tag 0.1.0
```

The live smoke test is read-only. It resolves the current cmux topology, reads notifications, validates canonical UUIDs, and loads three bounded lines from one selected surface. It does not focus a surface or send terminal input.

## 3. Vault-local verification

Build the plugin, then copy only `main.js`, `manifest.json`, and `styles.css` into an isolated development vault under `.obsidian/plugins/<manifest-id>/`. Preserve the vault-local `data.json`.

Launch Obsidian normally through Finder, Dock, Spotlight, or macOS LaunchServices. Do not launch Obsidian from a cmux terminal for this test.

For a pre-release `agent-cockpit` installation, copy its `data.json` into neither folder manually. Install the new ID alongside it, then disable—but do not delete—the legacy plugin before enabling `cmux-agent-orchestrator`. The disabled legacy folder remains available for the automatic non-destructive import. Confirm the task bindings are visible before removing the old folder.

Verify manually:

- Obsidian loads the plugin without console errors.
- The connection state is `cmux connected` after a normal macOS launch.
- Work, Agent runs, and cmux sections render in both light and dark themes.
- Keyboard focus, hover states, horizontal board scrolling, and narrow-window layout remain usable.
- The live workspace, pane, and surface tree matches cmux.
- A bounded preview loads on demand and disappears after plugin reload.
- Creating a task and attaching a session persists through reload without changing the agent.
- Moving a task changes workflow only.
- Focus in cmux targets a user-approved development surface and sends no text.
- Disabling and re-enabling the plugin leaves all cmux sessions running.

## 4. Publish

Merge the verified release branch into the default branch. Create and push a tag matching the manifest version exactly, without a `v` prefix. The release workflow rebuilds, reruns checks, validates metadata, and uploads `main.js`, `manifest.json`, and `styles.css` to the GitHub release.

For the initial release, link the public GitHub repository in the Obsidian Community directory and run its preview scan before publishing the listing. Address errors and warnings with an incremented plugin version and a new GitHub release.
