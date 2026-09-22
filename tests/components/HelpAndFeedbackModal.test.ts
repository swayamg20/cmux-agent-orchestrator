import { Modal, Setting, type App } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpAndFeedbackModal } from "../../src/components/HelpAndFeedbackModal";
import { FEEDBACK_LINKS } from "../../src/support/FeedbackLinks";
import type { ButtonComponent, MockElement } from "../mocks/obsidian";

function descendants(root: MockElement): MockElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

describe("HelpAndFeedbackModal", () => {
  beforeEach(() => {
    (Modal as unknown as { instances: Modal[] }).instances.length = 0;
    (Setting as unknown as { instances: Setting[] }).instances.length = 0;
  });

  it("shows explicit destinations and a read-only diagnostics preview", () => {
    const modal = new HelpAndFeedbackModal({} as App, "{\n  \"safe\": true\n}", async () => undefined);
    modal.open();

    const elements = descendants(modal.contentEl as unknown as MockElement);
    const links = elements.filter((element) => element.tagName === "a");
    const preview = elements.find((element) => element.tagName === "textarea");

    expect(links.map((link) => link.href).sort()).toEqual(Object.values(FEEDBACK_LINKS).sort());
    expect(links.every((link) => link.target === "_blank")).toBe(true);
    expect(links.every((link) => link.rel === "noopener noreferrer")).toBe(true);
    expect(preview).toMatchObject({
      value: "{\n  \"safe\": true\n}",
      readOnly: true,
      rows: 14
    });
    expect(preview?.attributes.get("aria-label")).toBe("Diagnostics preview");
  });

  it("copies only after an explicit click and re-enables the action", async () => {
    const copy = vi.fn(async () => undefined);
    const modal = new HelpAndFeedbackModal({} as App, "safe", copy);
    modal.open();
    const setting = (Setting as unknown as {
      instances: Array<{ buttons: ButtonComponent[] }>;
    }).instances.at(-1)!;
    const button = setting.buttons[0]!;

    expect(copy).not.toHaveBeenCalled();
    button.click();
    expect(button.disabled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(copy).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(false);
  });

  it("cleans up without a late button update when closed during a copy", async () => {
    let finish!: () => void;
    const copying = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const closed = vi.fn();
    const modal = new HelpAndFeedbackModal({} as App, "safe", () => copying, closed);
    modal.open();
    const setting = (Setting as unknown as {
      instances: Array<{ buttons: ButtonComponent[] }>;
    }).instances.at(-1)!;
    const button = setting.buttons[0]!;

    button.click();
    modal.close();
    finish();
    await copying;
    await Promise.resolve();

    expect(closed).toHaveBeenCalledOnce();
    expect(button.disabledValues).toEqual([true]);
  });
});
