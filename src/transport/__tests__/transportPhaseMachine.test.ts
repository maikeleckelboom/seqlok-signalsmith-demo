import { describe, expect, it, beforeEach } from "vitest";
import { createTransportState, type TransportPhase } from "../transportState";
import {
  invariantPhaseTransition,
  invariantSourceCursorNonNegative,
  invariantPausedIdleNoCursorAdvance,
  invariantFlushDoesNotConsumeInput,
  invariantInputDebtFinite,
  clearLastViolations,
  getLastViolations,
} from "../transportInvariants";

describe("transport phase transitions", () => {
  beforeEach(() => {
    clearLastViolations();
  });

  it("idle -> priming -> running is valid", () => {
    const state = createTransportState();
    expect(state.phase).toBe("idle");

    state.phase = "priming";
    invariantPhaseTransition("idle", "priming", state);
    expect(getLastViolations().length).toBe(0);

    state.phase = "running";
    invariantPhaseTransition("priming", "running", state);
    expect(getLastViolations().length).toBe(0);
  });

  it("running -> drainingInput -> flushingTail -> idle is valid", () => {
    const state = createTransportState();
    state.phase = "running";

    state.phase = "drainingInput";
    invariantPhaseTransition("running", "drainingInput", state);
    expect(getLastViolations().length).toBe(0);

    state.phase = "flushingTail";
    invariantPhaseTransition("drainingInput", "flushingTail", state);
    expect(getLastViolations().length).toBe(0);

    state.phase = "idle";
    invariantPhaseTransition("flushingTail", "idle", state);
    expect(getLastViolations().length).toBe(0);
  });

  it("running -> paused -> priming -> running is valid", () => {
    const state = createTransportState();
    state.phase = "running";

    state.phase = "paused";
    invariantPhaseTransition("running", "paused", state);
    expect(getLastViolations().length).toBe(0);

    state.phase = "priming";
    invariantPhaseTransition("paused", "priming", state);
    expect(getLastViolations().length).toBe(0);

    state.phase = "running";
    invariantPhaseTransition("priming", "running", state);
    expect(getLastViolations().length).toBe(0);
  });

  it("detects invalid idle -> drainingInput transition", () => {
    clearLastViolations();
    const state = createTransportState();
    state.phase = "drainingInput";
    invariantPhaseTransition("idle", "drainingInput", state);
    expect(getLastViolations().length).toBe(1);
    expect(getLastViolations()[0]!.rule).toBe("phaseTransition");
  });

  it("detects invalid priming -> drainingInput transition", () => {
    const state = createTransportState();
    state.phase = "drainingInput";
    invariantPhaseTransition("priming", "drainingInput", state);
    expect(getLastViolations().length).toBe(1);
  });

  it("allows self-transitions for stable phases", () => {
    const phases: TransportPhase[] = [
      "idle",
      "running",
      "paused",
      "drainingInput",
      "flushingTail",
    ];

    for (const phase of phases) {
      clearLastViolations();
      const state = createTransportState();
      state.phase = phase;
      invariantPhaseTransition(phase, phase, state);
      expect(getLastViolations().length).toBe(0);
    }
  });

  it("rejects priming self-transition", () => {
    clearLastViolations();
    const state = createTransportState();
    state.phase = "priming";
    invariantPhaseTransition("priming", "priming", state);
    expect(getLastViolations().length).toBe(1);
    expect(getLastViolations()[0]!.rule).toBe("phaseTransition");
  });

  it("source cursor must stay non-negative", () => {
    const state = createTransportState();
    state.sourceFrameCursor = -1;
    invariantSourceCursorNonNegative(state);
    expect(getLastViolations().length).toBe(1);
    expect(getLastViolations()[0]!.rule).toBe("sourceCursorNonNegative");

    clearLastViolations();
    state.sourceFrameCursor = 0;
    invariantSourceCursorNonNegative(state);
    expect(getLastViolations().length).toBe(0);
  });

  it("paused/idle must not advance source cursor", () => {
    const state = createTransportState();
    state.phase = "paused";
    invariantPausedIdleNoCursorAdvance(state, 100, 100);
    expect(getLastViolations().length).toBe(0);

    invariantPausedIdleNoCursorAdvance(state, 100, 101);
    expect(getLastViolations().length).toBe(1);
    expect(getLastViolations()[0]!.rule).toBe("pausedIdleNoCursorAdvance");

    clearLastViolations();
    state.phase = "idle";
    invariantPausedIdleNoCursorAdvance(state, 0, 1);
    expect(getLastViolations().length).toBe(1);
  });

  it("flushingTail must not consume input", () => {
    const state = createTransportState();
    state.phase = "flushingTail";
    invariantFlushDoesNotConsumeInput(state, 0);
    expect(getLastViolations().length).toBe(0);

    invariantFlushDoesNotConsumeInput(state, 1);
    expect(getLastViolations().length).toBe(1);
    expect(getLastViolations()[0]!.rule).toBe("flushDoesNotConsumeInput");
  });

  it("input debt must be finite", () => {
    const state = createTransportState();
    state.inputDebtFrames = NaN;
    invariantInputDebtFinite(state);
    expect(getLastViolations().length).toBe(1);

    clearLastViolations();
    state.inputDebtFrames = Infinity;
    invariantInputDebtFinite(state);
    expect(getLastViolations().length).toBe(1);

    clearLastViolations();
    state.inputDebtFrames = 0.5;
    invariantInputDebtFinite(state);
    expect(getLastViolations().length).toBe(0);
  });
});
