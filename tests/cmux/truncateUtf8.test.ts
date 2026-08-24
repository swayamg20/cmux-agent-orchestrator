import { describe, expect, it } from "vitest";
import { truncateUtf8 } from "../../src/cmux/CliCmuxTransport";

describe("truncateUtf8", () => {
  it("bounds by bytes without leaving a replacement character", () => {
    const result = truncateUtf8("hello 🌍 world", 8);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(8);
    expect(result.text).not.toContain("�");
    expect(result.truncated).toBe(true);
  });
});
