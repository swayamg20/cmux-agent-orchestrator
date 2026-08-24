import type { ConnectionState } from "../state/types";

export type CmuxConnectionGuidanceKind = "setup" | "unsafe" | "unavailable";

export const CMUX_PASSWORD_SETUP_STEPS = [
  "Open cmux and choose cmux → Settings… (⌘,).",
  "Open the Automation section.",
  "Set Socket Control Mode to Password mode.",
  "Set a Socket Password inside cmux. Agent Cockpit never receives it.",
  "Return to Obsidian and select Test connection."
] as const;

export const CMUX_SETUP_CLIPBOARD_TEXT = `${CMUX_PASSWORD_SETUP_STEPS.map(
  (step, index) => `${String(index + 1)}. ${step}`
).join("\n")}

Alternative: Automation mode permits external clients running as your macOS user without a password.
Do not select Full open access.`;

export function cmuxConnectionGuidance(
  connection: ConnectionState
): CmuxConnectionGuidanceKind | null {
  if (connection.status === "connected") {
    if (connection.accessMode === "cmuxOnly") return "setup";
    if (connection.accessMode === "allowAll") return "unsafe";
    return null;
  }
  if (connection.status === "access-blocked") return "setup";
  return "unavailable";
}
