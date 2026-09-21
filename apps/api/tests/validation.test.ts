import { describe, expect, it } from "vitest";
import {
  attachmentPhases,
  batchCreateSchema,
  colorChangeBatchSchema,
  colorChangeInputSchema,
  colorChangeVoidSchema,
  consumptionInputSchema,
  convertQuantity
} from "@handcraft/contracts";

describe("API business validation contracts", () => {
  it("normalizes a valid batch payload", () => {
    const result = batchCreateSchema.parse({
      materialId: "00000000-0000-0000-0000-000000000001",
      receivedAt: "2026-09-13",
      initialQuantity: "1.5",
      entryUnit: "kg"
    });
    expect(result.entryUnit).toBe("kg");
  });

  it("requires at least one consumption quantity", () => {
    const base = {
      projectId: "00000000-0000-0000-0000-000000000001",
      batchId: "00000000-0000-0000-0000-000000000002",
      usedQuantity: "0",
      wasteQuantity: "0",
      unit: "g"
    };
    expect(consumptionInputSchema.safeParse(base).success).toBe(false);
    expect(consumptionInputSchema.safeParse({ ...base, wasteQuantity: "10" }).success).toBe(true);
  });

  it("rejects zero affected quantity for color changes", () => {
    const result = colorChangeInputSchema.safeParse({
      batchId: "00000000-0000-0000-0000-000000000002",
      changeType: "OTHER",
      afterColorName: "Test",
      affectedQuantity: "0",
      unit: "g",
      occurredAt: "2026-09-13T10:00:00+08:00"
    });
    expect(result.success).toBe(false);
  });

  it("keeps inventory units in compatible families", () => {
    expect(convertQuantity("2.5", "l", "ml")).toBe("2500.000000");
    expect(() => convertQuantity("2.5", "l", "kg")).toThrow();
  });

  it("accepts a color-change batch backfill and rejects empty batches", () => {
    const valid = colorChangeBatchSchema.safeParse({
      batchId: "00000000-0000-0000-0000-000000000002",
      changes: [
        { changeType: "OTHER", afterColorName: "旧色", occurredAt: "2026-09-01T08:00:00+08:00" },
        { changeType: "OXIDATION", afterColorName: "新色", occurredAt: "2026-09-02T08:00:00+08:00" }
      ]
    });
    expect(valid.success).toBe(true);
    expect(colorChangeBatchSchema.safeParse({ batchId: "00000000-0000-0000-0000-000000000002", changes: [] }).success).toBe(false);
  });

  it("requires a void reason of at least three characters", () => {
    expect(colorChangeVoidSchema.safeParse({ reason: "误录作废" }).success).toBe(true);
    expect(colorChangeVoidSchema.safeParse({ reason: "误" }).success).toBe(false);
  });

  it("exposes before/after evidence phases", () => {
    expect(attachmentPhases).toEqual(["BEFORE", "AFTER"]);
  });
});
