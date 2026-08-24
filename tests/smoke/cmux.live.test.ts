import { describe, expect, it } from "vitest";
import { CmuxClient } from "../../src/cmux/CmuxClient";
import { isCanonicalUuid } from "../../src/cmux/commandBuilders";

const live = process.env.AGENT_COCKPIT_LIVE_CMUX === "1" ? describe : describe.skip;

live("installed cmux read-only smoke", () => {
  it("probes, discovers canonical topology, reads notifications, and bounds one preview", async () => {
    const client = await CmuxClient.create("/Applications/cmux.app/Contents/Resources/bin/cmux");
    try {
      const probe = await client.probe();
      expect(probe.versionText).toMatch(/^cmux 0\.62\.2\b/);
      expect(probe.capabilities.protocol).toBe("cmux-socket");

      const [snapshot, notifications, focused] = await Promise.all([
        client.snapshot(),
        client.notifications(),
        client.focusedTarget()
      ]);
      const workspaces = snapshot.windows.flatMap((window) => window.workspaces);
      const sessions = workspaces.flatMap((workspace) =>
        workspace.panes.flatMap((pane) =>
          pane.surfaces.map((surface) => ({ workspace, pane, surface }))
        )
      );
      expect(workspaces.length).toBeGreaterThan(0);
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.every(({ workspace, pane, surface }) =>
        isCanonicalUuid(workspace.id) && isCanonicalUuid(pane.id) && isCanonicalUuid(surface.id)
      )).toBe(true);
      expect(Array.isArray(notifications)).toBe(true);
      expect(focused).not.toBeNull();
      expect(
        focused !== null &&
          isCanonicalUuid(focused.workspaceId) &&
          isCanonicalUuid(focused.paneId) &&
          isCanonicalUuid(focused.surfaceId)
      ).toBe(true);

      const selected =
        sessions.find(({ workspace, surface }) => workspace.selected && (surface.selected || surface.focused)) ?? sessions[0]!;
      const preview = await client.readPreview(
        {
          workspaceId: selected.workspace.id,
          paneId: selected.pane.id,
          surfaceId: selected.surface.id
        },
        { lines: 3, maxBytes: 4_096 }
      );
      expect(Buffer.byteLength(preview.text, "utf8")).toBeLessThanOrEqual(4_096);
    } finally {
      client.dispose();
    }
  });
});
