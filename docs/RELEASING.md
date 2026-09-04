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
CMUX_AGENT_ORCHESTRATOR_LIVE_PROVIDERS=1 npm test -- tests/smoke/provider-metadata.live.test.ts
CMUX_AGENT_ORCHESTRATOR_LIVE_IDENTITY=1 npm test -- tests/smoke/automatic-identity.live.test.ts
CMUX_AGENT_ORCHESTRATOR_LIVE_TRACKING=1 npm test -- tests/smoke/automatic-tracking.live.test.ts
npm run validate:release -- --tag 0.2.0
```

The live smoke tests are read-only. They resolve current cmux topology, notifications, canonical UUIDs, three bounded lines from one selected surface, bounded local provider-title metadata, and exact automatic provider-to-surface identity where local evidence permits. The automatic-tracking smoke persists its generated task Markdown and binding data only to in-memory doubles, supplies blank terminal previews, and fails if focus is attempted. The smoke tests do not send terminal input, resume a conversation, modify provider files, or write to a real vault.

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
- A detected agent can be matched to an exact local provider conversation; its title survives reload while raw title metadata remains absent from `data.json`.
- Two same-repository surfaces can be assigned different provider conversations, and assigning one conversation to two surfaces fails closed.
- Creating a task and attaching a session persists through reload without changing the agent.
- Moving a task changes workflow only.
- Focus in cmux targets a user-approved development surface and sends no text.
- Disabling and re-enabling the plugin leaves all cmux sessions running.

## 4. Publish

Merge the verified release branch into the default branch. Create and push a tag matching the manifest version exactly, without a `v` prefix. The release workflow rebuilds, reruns checks, validates metadata, signs GitHub provenance attestations for `main.js`, `manifest.json`, and `styles.css`, and uploads those assets to the GitHub release.

For the initial release, link the public GitHub repository in the Obsidian Community directory and run its preview scan before publishing the listing. Address errors and warnings with an incremented plugin version and a new GitHub release.
