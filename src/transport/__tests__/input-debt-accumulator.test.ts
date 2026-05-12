import { describe, expect, it } from "vitest";
import { createInputDebtAccumulator } from "../input-debt-accumulator";

describe("inputDebtAccumulator", () => {
  it("returns zero when playbackRate is zero", () => {
    const acc = createInputDebtAccumulator();
    expect(acc.accumulate(128, 0)).toBe(0);
    expect(acc.accumulate(128, 0)).toBe(0);
    expect(acc.debt).toBe(0);
  });

  it("accumulates exact integer debt over multiple quanta", () => {
    const acc = createInputDebtAccumulator();
    // 128 * 1.0 = exactly 128 each quantum
    expect(acc.accumulate(128, 1)).toBe(128);
    expect(acc.accumulate(128, 1)).toBe(128);
    expect(acc.debt).toBe(0);
  });

  it("carries fractional debt across quanta", () => {
    const acc = createInputDebtAccumulator();
    // 128 * 0.5 = 64.0 exactly, no fraction
    expect(acc.accumulate(128, 0.5)).toBe(64);
    expect(acc.debt).toBe(0);

    // 100 * 0.75 = 75.0 exactly
    expect(acc.accumulate(100, 0.75)).toBe(75);
    expect(acc.debt).toBe(0);
  });

  it("accumulates fractional remainder and releases it later", () => {
    const acc = createInputDebtAccumulator();
    // 100 * 0.3 = 30.0 exactly
    expect(acc.accumulate(100, 0.3)).toBe(30);
    expect(acc.debt).toBe(0);

    // 100 * 0.333333 = 33.3333 -> floor 33, debt ~0.3333
    const r1 = acc.accumulate(100, 0.333_333);
    expect(r1).toBe(33);
    expect(acc.debt).toBeGreaterThan(0);
    expect(acc.debt).toBeLessThan(1);

    // Continue until the fractional debt crosses an integer boundary
    let total = 33;
    for (let i = 0; i < 10; i++) {
      total += acc.accumulate(100, 0.333_333);
    }
    // Total requested input across 11 blocks should be roughly 366
    expect(total).toBeGreaterThan(360);
    expect(total).toBeLessThan(370);
  });

  it("never returns negative frames", () => {
    const acc = createInputDebtAccumulator();
    expect(acc.accumulate(128, -1)).toBeLessThanOrEqual(0);
    expect(acc.accumulate(0, 1)).toBe(0);
  });

  it("resets debt to zero", () => {
    const acc = createInputDebtAccumulator();
    acc.accumulate(128, 1.7);
    expect(acc.debt).toBeGreaterThanOrEqual(0);
    acc.reset();
    expect(acc.debt).toBe(0);
    expect(acc.accumulate(128, 1)).toBe(128);
  });
});
