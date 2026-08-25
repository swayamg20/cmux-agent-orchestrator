import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "obsidian";
import {
  LegacyDataImportError,
  LEGACY_PLUGIN_ID,
  loadLegacyPluginData
} from "../../src/bindings/LegacyDataImporter";

function pluginWithLegacyData(options?: { currentId?: string; size?: number; source?: string }) {
  const source = options?.source ?? JSON.stringify({ schemaVersion: 1, settings: {}, machines: {} });
  const stat = vi.fn(async () => ({
    type: "file" as const,
    ctime: 0,
    mtime: 0,
    size: options?.size ?? Buffer.byteLength(source, "utf8")
  }));
  const read = vi.fn(async () => source);
  const plugin = {
    manifest: { id: options?.currentId ?? "renamed-cockpit" },
    app: {
      vault: {
        configDir: ".custom-config",
        adapter: {
          stat,
          read
        }
      }
    }
  } as unknown as Plugin;
  return { plugin, read, stat };
}

describe("legacy plugin data import", () => {
  it("reads only the bounded legacy data file under the vault config directory", async () => {
    const { plugin, stat } = pluginWithLegacyData();
    await expect(loadLegacyPluginData(plugin)).resolves.toMatchObject({ schemaVersion: 1 });
    expect(stat).toHaveBeenCalledWith(".custom-config/plugins/agent-cockpit/data.json");
  });

  it("does not import from the currently running legacy plugin folder", async () => {
    const { plugin, stat } = pluginWithLegacyData({ currentId: LEGACY_PLUGIN_ID });
    await expect(loadLegacyPluginData(plugin)).resolves.toBeNull();
    expect(stat).not.toHaveBeenCalled();
  });

  it("fails closed for oversized or malformed legacy data", async () => {
    await expect(
      loadLegacyPluginData(pluginWithLegacyData({ size: 17 * 1024 * 1024 }).plugin)
    ).rejects.toBeInstanceOf(LegacyDataImportError);
    await expect(loadLegacyPluginData(pluginWithLegacyData({ source: "not json" }).plugin)).rejects.toThrow(
      /not valid JSON/
    );
  });
});
