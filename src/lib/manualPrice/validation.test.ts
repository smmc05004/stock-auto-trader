import { describe, expect, it } from "vitest";
import { previewManualPrice } from "./validation";

describe("manual price validation", () => {
  it("calculates a positive after-cost preview", () => {
    expect(previewManualPrice({ buyPrice: 10_000, sellPrice: 10_100, budget: 1_000_000 })).toMatchObject({ quantity: 99, tax: 0 });
  });
  it("rejects prices that do not cover fees", () => {
    expect(() => previewManualPrice({ buyPrice: 100_000, sellPrice: 100_005, budget: 1_000_000 })).toThrow(/순이익/);
  });
  it("rejects values outside the paper budget", () => {
    expect(() => previewManualPrice({ buyPrice: 10_000, sellPrice: 10_100, budget: 1_000_001 })).toThrow(/예산/);
  });
});
