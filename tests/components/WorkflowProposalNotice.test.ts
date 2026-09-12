import { describe, expect, it, vi } from "vitest";
import type { AppliedWorkflowChange } from "../../src/state/types";
import type { WorkflowProposal } from "../../src/workflow/WorkflowAutomationPolicy";
import {
  renderAppliedWorkflowChange,
  renderWorkflowProposalNotice
} from "../../src/components/WorkflowProposalNotice";

class TestElement {
  readonly children: TestElement[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  tag = "div";
  text = "";
  className = "";
  disabled = false;

  createDiv(options: { cls?: string; text?: string } = {}): TestElement {
    return this.createChild("div", options);
  }

  createEl(
    tag: string,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {}
  ): TestElement {
    return this.createChild(tag, options);
  }

  createSpan(options: { cls?: string; text?: string } = {}): TestElement {
    return this.createChild("span", options);
  }

  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  trigger(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }

  descendants(): TestElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  private createChild(
    tag: string,
    options: { cls?: string; text?: string }
  ): TestElement {
    const child = new TestElement();
    child.tag = tag;
    child.className = options.cls ?? "";
    child.text = options.text ?? "";
    this.children.push(child);
    return child;
  }
}

function proposal(): WorkflowProposal {
  return {
    id: "proposal-1",
    taskId: "11111111-1111-4111-8111-111111111111",
    sessionKey: "workspace:pane:surface",
    from: "active",
    to: "review",
    reason: "turn-finished",
    explanation: "Fresh structured evidence says the turn completed.",
    confidence: "high",
    source: "provider-lifecycle",
    evidenceId: "evidence-1",
    observedAt: Date.now(),
    applyAutomatically: false
  };
}

describe("WorkflowProposalNotice", () => {
  it("keeps task-card suggestions compact and routes Apply without duplicate clicks", async () => {
    let release!: (value: boolean) => void;
    const operation = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const apply = vi.fn(() => operation);
    const dismiss = vi.fn(async () => true);
    const root = new TestElement();

    renderWorkflowProposalNotice(
      root as unknown as HTMLElement,
      proposal(),
      { apply, dismiss },
      "task"
    );
    const buttons = root.descendants().filter((element) => element.tag === "button");
    expect(root.descendants().map((element) => element.text)).toContain("Ready for review");
    expect(root.descendants().map((element) => element.text)).not.toContain(
      "Fresh structured evidence says the turn completed."
    );

    buttons[0]!.trigger("click");
    buttons[0]!.trigger("click");
    expect(apply).toHaveBeenCalledOnce();
    expect(buttons.map((button) => button.disabled)).toEqual([true, true]);

    release(true);
    await operation;
    await Promise.resolve();
    expect(buttons.map((button) => button.disabled)).toEqual([false, false]);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("routes Dismiss and labels Safe auto proposals honestly", async () => {
    const apply = vi.fn(async () => true);
    const dismiss = vi.fn(async () => true);
    const root = new TestElement();
    const automatic = { ...proposal(), applyAutomatically: true };

    renderWorkflowProposalNotice(
      root as unknown as HTMLElement,
      automatic,
      { apply, dismiss },
      "attention"
    );
    const buttons = root.descendants().filter((element) => element.tag === "button");
    expect(root.descendants().map((element) => element.text)).toContain(
      "Safe auto eligible: Review"
    );
    expect(root.descendants().map((element) => element.text)).toContain(
      "Active → Review · Fresh structured evidence says the turn completed."
    );

    buttons[1]!.trigger("click");
    await Promise.resolve();
    expect(dismiss).toHaveBeenCalledWith(automatic);
    expect(apply).not.toHaveBeenCalled();
  });

  it("renders a visible marker for an automatic workflow change", () => {
    const root = new TestElement();
    const change: AppliedWorkflowChange = {
      proposalId: "proposal-1",
      taskId: "11111111-1111-4111-8111-111111111111",
      taskUpdatedAt: "2026-09-06T04:00:00.000Z",
      from: "active",
      to: "review",
      explanation: "Fresh structured evidence says the turn completed.",
      appliedAt: Date.now()
    };

    renderAppliedWorkflowChange(root as unknown as HTMLElement, change);

    expect(root.descendants().map((element) => element.text)).toEqual([
      "",
      "Safe auto",
      "Moved automatically to Review"
    ]);
  });
});
