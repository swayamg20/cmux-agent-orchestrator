import { describe, expect, it } from "vitest";
import { CmuxClient } from "../../src/cmux/CmuxClient";
import { ProviderMetadataService } from "../../src/providers/ProviderMetadataService";
import { AutomaticProviderSessionResolver } from "../../src/providers/identity/AutomaticProviderSessionResolver";
import { providerMetadataKey } from "../../src/providers/ProviderMetadataService";
import { isCanonicalUuid } from "../../src/security/identifiers";

const live =
  process.env.CMUX_AGENT_ORCHESTRATOR_LIVE_IDENTITY === "1" ? describe : describe.skip;

live("installed automatic provider identity read-only smoke", () => {
  it("maps current provider writers to canonical cmux surfaces without controlling them", async () => {
    const client = await CmuxClient.create("/Applications/cmux.app/Contents/Resources/bin/cmux");
    const metadata = new ProviderMetadataService();
    const resolver = new AutomaticProviderSessionResolver(metadata);
    try {
      const snapshot = await client.snapshot();
      const result = await resolver.resolve(snapshot, client);
      const surfaceIds = new Set(
        snapshot.windows.flatMap((window) =>
          window.workspaces.flatMap((workspace) =>
            workspace.panes.flatMap((pane) => pane.surfaces.map((surface) => surface.id))
          )
        )
      );
      const cwdBySurface = new Map(
        snapshot.windows.flatMap((window) =>
          window.workspaces.flatMap((workspace) =>
            workspace.panes.flatMap((pane) =>
              pane.surfaces.map((surface) => [surface.id, workspace.currentDirectory] as const)
            )
          )
        )
      );

      expect(result.mappings.length).toBeGreaterThan(0);
      expect(new Set(result.mappings.map((mapping) => mapping.surfaceId)).size).toBe(
        result.mappings.length
      );
      expect(
        new Set(
          result.mappings.map(
            (mapping) => `${mapping.provider}:${mapping.providerSessionId}`
          )
        ).size
      ).toBe(result.mappings.length);
      for (const mapping of result.mappings) {
        expect(surfaceIds.has(mapping.surfaceId)).toBe(true);
        expect(isCanonicalUuid(mapping.workspaceId)).toBe(true);
        expect(isCanonicalUuid(mapping.paneId)).toBe(true);
        expect(isCanonicalUuid(mapping.surfaceId)).toBe(true);
        expect(isCanonicalUuid(mapping.providerSessionId)).toBe(true);
        const cwd = cwdBySurface.get(mapping.surfaceId);
        expect(cwd).toBeTruthy();
        const session =
          metadata.evidence.get(providerMetadataKey(mapping.provider, mapping.providerSessionId)) ??
          (await metadata.get(mapping.provider, mapping.providerSessionId, cwd!));
        expect(session).toMatchObject({
          provider: mapping.provider,
          sessionId: mapping.providerSessionId,
          cwd
        });
        expect(session?.title.length).toBeGreaterThan(0);
      }
    } finally {
      resolver.dispose();
      metadata.dispose();
      client.dispose();
    }
  }, 60_000);
});
