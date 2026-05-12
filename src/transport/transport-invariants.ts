import type { TransportPhase, TransportState } from "./transport-state";

export interface InvariantViolation {
  readonly rule: string;
  readonly phase: TransportPhase;
  readonly detail: string;
}

let lastViolations: InvariantViolation[] = [];

export function getLastViolations(): readonly InvariantViolation[] {
  return lastViolations;
}

export function clearLastViolations(): void {
  lastViolations = [];
}

function report(rule: string, state: TransportState, detail: string): void {
  const violation: InvariantViolation = {
    rule,
    phase: state.phase,
    detail,
  };
  lastViolations.push(violation);
  if (typeof console !== "undefined" && console.warn) {
    console.warn(`[transport-invariant] ${rule}: ${detail} (phase=${state.phase})`);
  }
}

/**
 * Assert that the source frame cursor never goes negative.
 */
export function invariantSourceCursorNonNegative(state: TransportState): void {
  if (state.sourceFrameCursor < 0) {
    report(
      "sourceCursorNonNegative",
      state,
      `sourceFrameCursor=${state.sourceFrameCursor}`,
    );
  }
}

/**
 * Assert that canonical input segment capacity is sufficient before reads.
 */
export function invariantCanonicalCapacity(
  state: TransportState,
  capacity: number,
  requestedFrames: number,
): void {
  if (requestedFrames > capacity) {
    report(
      "canonicalCapacity",
      state,
      `requested=${requestedFrames} capacity=${capacity}`,
    );
  }
}

/**
 * Assert that pre-roll frames never exceed allocated pre-roll capacity.
 */
export function invariantPreRollCapacity(
  state: TransportState,
  capacity: number,
  preRollFrames: number,
): void {
  if (preRollFrames > capacity) {
    report(
      "preRollCapacity",
      state,
      `preRollFrames=${preRollFrames} capacity=${capacity}`,
    );
  }
}

/**
 * Assert that flushingTail never consumes new source frames.
 */
export function invariantFlushDoesNotConsumeInput(
  state: TransportState,
  inputFramesReadInBlock: number,
): void {
  if (state.phase === "flushingTail" && inputFramesReadInBlock > 0) {
    report(
      "flushDoesNotConsumeInput",
      state,
      `inputFramesReadInBlock=${inputFramesReadInBlock}`,
    );
  }
}

/**
 * Assert that paused/idle do not accidentally advance source cursor.
 */
export function invariantPausedIdleNoCursorAdvance(
  state: TransportState,
  cursorBefore: number,
  cursorAfter: number,
): void {
  if (
    (state.phase === "paused" || state.phase === "idle") &&
    cursorAfter !== cursorBefore
  ) {
    report(
      "pausedIdleNoCursorAdvance",
      state,
      `cursorBefore=${cursorBefore} cursorAfter=${cursorAfter}`,
    );
  }
}

/**
 * Assert that input debt never becomes NaN or infinite.
 */
export function invariantInputDebtFinite(state: TransportState): void {
  if (!Number.isFinite(state.inputDebtFrames)) {
    report(
      "inputDebtFinite",
      state,
      `inputDebtFrames=${state.inputDebtFrames}`,
    );
  }
}

const VALID_PHASE_TRANSITIONS: Readonly<Record<TransportPhase, readonly TransportPhase[]>> = {
  idle: ["idle", "priming", "paused", "running"],
  priming: ["running", "idle"],
  running: ["running", "paused", "drainingInput", "priming", "idle"],
  paused: ["paused", "priming", "idle", "running"],
  drainingInput: ["drainingInput", "flushingTail", "priming", "idle", "running"],
  flushingTail: ["flushingTail", "idle", "priming", "running"],
};

/**
 * Assert that phase transitions are coherent.
 */
export function invariantPhaseTransition(
  previous: TransportPhase,
  next: TransportPhase,
  state: TransportState,
): void {
  const allowed = VALID_PHASE_TRANSITIONS[previous];
  if (!allowed.includes(next)) {
    report(
      "phaseTransition",
      state,
      `illegal transition from ${previous} to ${next}`,
    );
  }
}
