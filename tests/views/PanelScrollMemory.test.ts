import { describe, expect, it } from "vitest";
import { PanelScrollMemory } from "../../src/views/PanelScrollMemory";

describe("PanelScrollMemory", () => {
  it("restores each section independently after its DOM is rebuilt", () => {
    const memory = new PanelScrollMemory<"work" | "cmux">();
    memory.capture("work", { scrollLeft: 4, scrollTop: 120 });
    memory.capture("cmux", { scrollLeft: 9, scrollTop: 860 });
    const work = { scrollLeft: 0, scrollTop: 0 };
    const cmux = { scrollLeft: 0, scrollTop: 0 };

    memory.restore("cmux", cmux);
    memory.restore("work", work);

    expect(cmux).toEqual({ scrollLeft: 9, scrollTop: 860 });
    expect(work).toEqual({ scrollLeft: 4, scrollTop: 120 });
  });

  it("leaves a section at its native position until it has been captured", () => {
    const memory = new PanelScrollMemory<"agents">();
    const element = { scrollLeft: 3, scrollTop: 17 };

    memory.restore("agents", element);

    expect(element).toEqual({ scrollLeft: 3, scrollTop: 17 });
  });

  it("forgets captured positions when the view closes", () => {
    const memory = new PanelScrollMemory<"cmux">();
    memory.capture("cmux", { scrollLeft: 8, scrollTop: 300 });
    memory.clear();
    const element = { scrollLeft: 0, scrollTop: 0 };

    memory.restore("cmux", element);

    expect(element).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });
});
