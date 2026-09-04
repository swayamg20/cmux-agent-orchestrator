import { describe, expect, it } from "vitest";
import { createTaskMarkdown } from "../../src/tasks/TaskTemplate";
import { assertWorkflowTransition, parseTaskRecord, type TaskRecord } from "../../src/tasks/TaskSchema";

describe("task schema", () => {
  it("creates durable Markdown without volatile cmux identities", () => {
    const markdown = createTaskMarkdown({
      title: "Parser\n---\nmalicious: true",
      taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workflowStatus: "active",
      priority: "normal",
      repository: "/repo:with:colons",
      branch: null,
      worktree: null,
      now: "2026-08-23T00:00:00.000Z"
    });
    expect(markdown).toContain("# Parser --- malicious: true");
    expect(markdown).toContain('title: "Parser --- malicious: true"');
    expect(markdown).not.toContain("cmux-surface-id");
    expect(markdown).not.toContain("terminal preview");
    expect(markdown).toContain('repository: "/repo:with:colons"');
  });

  it("parses only marked schema-version-one tasks", () => {
    const file = {
      basename: "Task",
      stat: { ctime: 1, mtime: 2 }
    } as TaskRecord["file"];
    const task = parseTaskRecord(file, {
      "agent-cockpit": "task",
      "schema-version": 1,
      "task-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Human task title",
      "workflow-status": "active",
      priority: "high"
    });
    expect(task).toMatchObject({ title: "Human task title", workflowStatus: "active", priority: "high" });
    expect(parseTaskRecord(file, { "agent-cockpit": "task", "schema-version": 2 })).toBeNull();
    expect(
      parseTaskRecord(file, {
        "agent-cockpit": "task",
        "schema-version": 1,
        "task-id": "task:1"
      })
    ).toBeNull();
  });

  it("normalizes task UUID casing at the Markdown trust boundary", () => {
    const file = {
      basename: "Task",
      stat: { ctime: 1, mtime: 2 }
    } as TaskRecord["file"];

    expect(
      parseTaskRecord(file, {
        "agent-cockpit": "task",
        "schema-version": 1,
        "task-id": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
      })?.taskId
    ).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("bounds untrusted frontmatter and normalizes invalid scalar values", () => {
    const file = {
      basename: "Task",
      stat: { ctime: 1, mtime: 2 }
    } as TaskRecord["file"];
    const task = parseTaskRecord(file, {
      "agent-cockpit": "task",
      "schema-version": 1,
      "task-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "x".repeat(1_000),
      "created-at": "not-a-date",
      "updated-at": "also-not-a-date",
      "run-count": Number.POSITIVE_INFINITY
    });
    expect(task?.title).toHaveLength(512);
    expect(task?.createdAt).toBe(new Date(1).toISOString());
    expect(task?.updatedAt).toBe(new Date(2).toISOString());
    expect(task?.runCount).toBe(0);
  });

  it("accepts workflow movement without implying runtime actions", () => {
    expect(() => assertWorkflowTransition("active", "review")).not.toThrow();
    expect(() => assertWorkflowTransition("review", "done")).not.toThrow();
  });
});
