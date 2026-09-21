import { describe, expect, it } from "vitest";
import { colorChangeBulkSchema, planColorChainSeq } from "../src/index.js";

describe("color change chain sequencing", () => {
  const existing = [
    { key: "a", occurredAt: "2026-09-01T10:00:00.000Z", createdAt: "2026-09-01T10:00:00.000Z" },
    { key: "c", occurredAt: "2026-09-03T10:00:00.000Z", createdAt: "2026-09-03T10:00:00.000Z" }
  ];

  it("places a single backdated entry between existing rows", () => {
    const plan = planColorChainSeq(existing, [{ index: 0, occurredAt: "2026-09-02T10:00:00.000Z" }]);
    expect(plan).toEqual(["a", "new:0", "c"]);
  });

  it("keeps the latest new entry as chain head even when entries are submitted in reverse order", () => {
    const plan = planColorChainSeq(existing, [
      { index: 0, occurredAt: "2026-09-05T10:00:00.000Z" },
      { index: 1, occurredAt: "2026-09-04T10:00:00.000Z" }
    ]);
    expect(plan).toEqual(["a", "c", "new:1", "new:0"]);
    expect(plan.at(-1)).toBe("new:0");
  });

  it("orders same-timestamp new entries by submission index after existing rows", () => {
    const plan = planColorChainSeq(existing, [
      { index: 0, occurredAt: "2026-09-03T10:00:00.000Z" },
      { index: 1, occurredAt: "2026-09-03T10:00:00.000Z" }
    ]);
    expect(plan).toEqual(["a", "c", "new:0", "new:1"]);
  });

  it("bulk schema requires at least one entry and rejects more than 100", () => {
    const entry = { changeType: "OTHER", afterColorName: "X", occurredAt: "2026-09-02T10:00:00.000Z" };
    expect(colorChangeBulkSchema.safeParse({ batchId: "00000000-0000-0000-0000-000000000001", entries: [] }).success).toBe(false);
    expect(colorChangeBulkSchema.safeParse({ batchId: "00000000-0000-0000-0000-000000000001", entries: [entry] }).success).toBe(true);
    expect(
      colorChangeBulkSchema.safeParse({ batchId: "00000000-0000-0000-0000-000000000001", entries: Array.from({ length: 101 }, () => entry) }).success
    ).toBe(false);
  });
});
