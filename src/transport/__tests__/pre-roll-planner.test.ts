import { describe, expect, it } from "vitest";
import { createPreRollPlanner } from "../pre-roll-planner";
import { createTransportState } from "../transport-state";
import { createSourceAssetReader } from "../source-asset-reader";

describe("preRollPlanner", () => {
  it("uses pendingSeekFrame when present", () => {
    const planner = createPreRollPlanner(256);
    const state = createTransportState();
    state.pendingSeekFrame = 1000;
    state.sourceFrameCursor = 500;

    const asset = {
      id: "a",
      channelCount: 2,
      sampleRate: 48000,
      totalFrames: 100_000,
      channels: [new Float32Array(100_000), new Float32Array(100_000)],
    };
    const reader = createSourceAssetReader(asset);

    const plan = planner.computePreRoll(state, reader);
    expect(plan.targetFrame).toBe(1000);
    expect(plan.preRollFrames).toBe(256);
    expect(plan.preRollInputFrames).toBe(256);
  });

  it("falls back to sourceFrameCursor when no seek is pending", () => {
    const planner = createPreRollPlanner(256);
    const state = createTransportState();
    state.sourceFrameCursor = 2048;

    const asset = {
      id: "a",
      channelCount: 2,
      sampleRate: 48000,
      totalFrames: 100_000,
      channels: [new Float32Array(100_000), new Float32Array(100_000)],
    };
    const reader = createSourceAssetReader(asset);

    const plan = planner.computePreRoll(state, reader);
    expect(plan.targetFrame).toBe(2048);
    expect(plan.preRollFrames).toBe(256);
  });

  it("returns zero preRollFrames when requiredPreRollFrames is zero", () => {
    const planner = createPreRollPlanner(0);
    const state = createTransportState();
    const plan = planner.computePreRoll(state, createSourceAssetReader(null));
    expect(plan.preRollFrames).toBe(0);
  });

  it("returns non-negative preRollFrames even for negative required input", () => {
    const planner = createPreRollPlanner(-10);
    const state = createTransportState();
    const plan = planner.computePreRoll(state, createSourceAssetReader(null));
    expect(plan.preRollFrames).toBe(0);
  });
});
