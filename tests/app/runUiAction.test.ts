import { Notice } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { runUiAction } from "../../src/app/runUiAction";

describe("runUiAction", () => {
  beforeEach(() => {
    (Notice as unknown as { messages: string[] }).messages.length = 0;
  });

  it("turns an async action failure into one readable notice", async () => {
    await expect(
      runUiAction(async () => {
        throw new Error("Obsidian could not create the view.");
      }, "Could not open the view.")
    ).resolves.toBeUndefined();

    expect((Notice as unknown as { messages: string[] }).messages).toEqual([
      "Obsidian could not create the view."
    ]);
  });

  it("catches a synchronous action throw", async () => {
    await runUiAction(() => {
      throw new Error("Controller is no longer available.");
    }, "Could not refresh the view.");

    expect((Notice as unknown as { messages: string[] }).messages).toEqual([
      "Controller is no longer available."
    ]);
  });

  it("uses the fallback when an action has no readable error message", async () => {
    await runUiAction(
      () => Promise.reject(new Error("")),
      "Could not refresh the view."
    );

    expect((Notice as unknown as { messages: string[] }).messages).toEqual([
      "Could not refresh the view."
    ]);
  });
});
