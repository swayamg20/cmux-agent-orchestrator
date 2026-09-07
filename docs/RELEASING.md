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
npm run test:live:read-only
RELEASE_VERSION="$(node -p "require('./manifest.json').version")"
npm run validate:release -- --tag "$RELEASE_VERSION"
```

The live smoke tests are read-only. They resolve current cmux topology, notifications, canonical UUIDs, feature-detected `sessions --json` or `list-agents` lifecycle records, three bounded lines from one selected surface, bounded local provider-title metadata, and exact automatic provider-to-surface identity where local evidence permits. The automatic-tracking smoke persists its generated task Markdown and binding data only to in-memory doubles, supplies blank terminal previews, and fails if focus is attempted. The deterministic suite covers both lifecycle command shapes, current/advertised event support, acknowledgement and heartbeat liveness, event decoding, burst coalescing, restart/replay/sequence gaps, unsupported-command fallback, and workflow-policy races. The smoke tests do not send terminal input, resume a conversation, modify provider files, or write to a real vault.

## 3. Vault-local verification

Build the plugin, then copy only `main.js`, `manifest.json`, and `styles.css` into an isolated development vault under `.obsidian/plugins/<manifest-id>/`. Preserve the vault-local `data.json`.

Launch Obsidian normally through Finder, Dock, Spotlight, or macOS LaunchServices. Do not launch Obsidian from a cmux terminal for this test.

For a pre-release `agent-cockpit` installation, copy its `data.json` into neither folder manually. Install the new ID alongside it, then disable—but do not delete—the legacy plugin before enabling `cmux-agent-orchestrator`. The disabled legacy folder remains available for the automatic non-destructive import. Confirm the task bindings are visible before removing the old folder.

Verify manually:

- Obsidian loads the plugin without console errors.
- The connection state is `cmux connected` after a normal macOS launch.
- On a cmux build that advertises live events, the connection tooltip reports automatic updates only after the protocol acknowledgement, a controlled topology change appears without pressing Refresh, and stopping the event child returns the tooltip to manual Refresh. On a legacy build, it reports that Refresh is manual and starts no polling process.
- Work, Agent runs, and cmux sections render in both light and dark themes; Work shows only Attention plus the compact workflow summary.
- Open board creates one dedicated native tab, invoking it again reuses that tab, and returning to the orchestrator works.
- The board keeps the page fixed while each column scrolls vertically and the column canvas scrolls horizontally. Keyboard focus, hover states, search, live-run filtering, and narrow-window layout remain usable.
- The live workspace, pane, and surface tree matches cmux.
- A bounded preview loads on demand and disappears after plugin reload.
- A detected agent can be matched to an exact local provider conversation; its title survives reload while raw title metadata remains absent from `data.json`.
- Two same-repository surfaces can be assigned different provider conversations, and assigning one conversation to two surfaces fails closed.
- With automatic tracking enabled, each uniquely resolved Claude or Codex conversation creates exactly one neutral Active Work task; conversation and terminal titles are absent from the generated Markdown.
- Refreshing and reloading Obsidian do not duplicate an automatically tracked task or run, and disabling automatic tracking prevents new tasks without changing existing tasks or agents.
- Manually detaching an automatically tracked run preserves the task and run history and does not silently recreate the binding after Refresh.
- If the same exact provider conversation is deliberately resumed on one new cmux surface after its previous full target disappears, Refresh reconnects the existing task without creating another task or run. Skip this controlled test when preserving current session placement takes priority.
- Creating a task and attaching a session persists through reload without changing the agent.
- Moving or deleting a linked task note updates the Work board and missing-task attention state without requiring an Obsidian restart.
- Moving a task changes workflow only.
- Entering and cancelling `Review no-live` changes no task. With a fresh connected snapshot, parking selected Active tasks without a present linked surface moves only those selected tasks to Parked; a task whose live surface reappears during confirmation is skipped.
- A rejected workflow move returns its selector to the persisted workflow state instead of displaying an unsaved value.
- With structured lifecycle evidence available, lowering the stale-working threshold and saving settings can surface an aged Working session in Attention without moving its task; Idle and State unknown sessions remain unflagged.
- Off mode creates no workflow proposal. Suggest mode shows an explanation with Apply and Dismiss, persists dismissal across reload, and never moves the card without Apply.
- Backlog-to-Active remains manual in every mode. Parked and Done never receive an automatic proposal.
- Notification-backed or partial evidence remains a suggestion in Safe auto mode. Only fresh, high-confidence structured evidence may apply Active to Review after a finished turn or Review to Active after work resumes, and the card shows a recent Safe auto marker afterward.
- When one task has several exact linked runs, fresh Working evidence from any sibling run keeps an Active-to-Review change manual even if another run has safely finished.
- Missing, idle, waiting, failed, stale, and State unknown sessions do not mutate workflow. No runtime evidence moves a task to Done.
- Focus in cmux targets a user-approved development surface and sends no text.
- Disabling and re-enabling the plugin leaves all cmux sessions running.

## 4. Publish

Merge the verified release branch into the default branch. Create and push a tag matching the manifest version exactly, without a `v` prefix. The release workflow rebuilds, reruns checks, validates metadata, signs GitHub provenance attestations for `main.js`, `manifest.json`, and `styles.css`, and uploads those assets to the GitHub release.

For the initial release, link the public GitHub repository in the Obsidian Community directory and run its preview scan before publishing the listing. Address errors and warnings with an incremented plugin version and a new GitHub release.
