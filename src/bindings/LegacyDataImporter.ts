import { Buffer } from "node:buffer";
import { normalizePath, type Plugin } from "obsidian";

export const LEGACY_PLUGIN_ID = "agent-cockpit";
const MAX_LEGACY_DATA_BYTES = 16 * 1024 * 1024;

export class LegacyDataImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyDataImportError";
  }
}

export async function loadLegacyPluginData(plugin: Plugin): Promise<unknown> {
  if (plugin.manifest?.id === LEGACY_PLUGIN_ID || plugin.manifest?.id === undefined) return null;
  const vault = plugin.app?.vault;
  if (vault === undefined) return null;

  const dataPath = normalizePath(`${vault.configDir}/plugins/${LEGACY_PLUGIN_ID}/data.json`);
  const details = await vault.adapter.stat(dataPath);
  if (details === null) return null;
  if (details.type !== "file") {
    throw new LegacyDataImportError("The legacy plugin data path is not a file.");
  }
  if (details.size > MAX_LEGACY_DATA_BYTES) {
    throw new LegacyDataImportError("The legacy plugin data file exceeds the safe migration limit.");
  }

  const source = await vault.adapter.read(dataPath);
  if (Buffer.byteLength(source, "utf8") > MAX_LEGACY_DATA_BYTES) {
    throw new LegacyDataImportError("The legacy plugin data file exceeds the safe migration limit.");
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new LegacyDataImportError("The legacy plugin data file is not valid JSON.");
  }
}
