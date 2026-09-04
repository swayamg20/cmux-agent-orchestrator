import { Notice } from "obsidian";

/**
 * Terminates a user-triggered async action at the UI boundary so Obsidian API
 * failures become visible notices instead of unhandled promise rejections.
 */
export async function runUiAction(
  action: () => Promise<void>,
  fallbackMessage: string,
  shouldReportError: () => boolean = () => true
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!shouldReportError()) return;
    new Notice(
      error instanceof Error && error.message.trim()
        ? error.message
        : fallbackMessage
    );
  }
}
