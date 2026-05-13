declare const TicketIdBrand: unique symbol;

export type TicketId = number & { readonly [TicketIdBrand]: never };

export type SwapPhase =
  | "idle"
  | "spawn"
  | "prime"
  | "prewarm"
  | "crossfade"
  | "retire";

export type SwapStepKind =
  | "idle"
  | "runCurrentOnly"
  | "runCurrentAndPrewarmNext"
  | "runBothForCrossfade"
  | "retireNow";

export interface SwapTicketRT<EngineKind extends number> {
  readonly ticketId: TicketId;
  readonly engineKind: EngineKind;
  readonly atFrame: number;
  readonly fadeFrames: number;
  readonly preWarmBlocks: number;
}

export interface SwapStatusRT<EngineKind extends number> {
  readonly phase: SwapPhase;
  readonly ticketId: number;
  readonly progress: number;
  readonly activeEngineKind: EngineKind;
  readonly nextEngineKind: EngineKind;
  readonly fadeTotalFrames: number;
  readonly fadeDoneFramesAtBlockStart: number;
  readonly fadeDoneFramesAtBlockEnd: number;
  readonly preWarmBlocksRemaining: number;
}

export interface SwapStateRT<EngineKind extends number> {
  phase: SwapPhase;
  hasTicket: boolean;
  ticket: SwapTicketRT<EngineKind>;
  totalFadeFrames: number;
  fadeFramesRemaining: number;
  preWarmBlocksRemaining: number;
  stepIndex: number;
  stepTotal: number;
}

export interface SwapStepDecisionRT<EngineKind extends number> {
  readonly kind: SwapStepKind;
  readonly status: SwapStatusRT<EngineKind>;
}

export type HotswapTicketErrorReason =
  | "ticketIdOutOfRange"
  | "fadeFramesNonPositive"
  | "preWarmBlocksNegative";

export class HotswapTicketError extends Error {
  readonly reason: HotswapTicketErrorReason;
  readonly ticketId?: number;
  readonly atFrame?: number;
  readonly fadeFrames?: number;
  readonly preWarmBlocks?: number;

  constructor(
    reason: HotswapTicketErrorReason,
    details: {
      readonly ticketId?: number;
      readonly atFrame?: number;
      readonly fadeFrames?: number;
      readonly preWarmBlocks?: number;
    } = {},
  ) {
    super(`Invalid hotswap ticket: ${reason}`);
    this.name = "HotswapTicketError";
    this.reason = reason;
    this.ticketId = details.ticketId;
    this.atFrame = details.atFrame;
    this.fadeFrames = details.fadeFrames;
    this.preWarmBlocks = details.preWarmBlocks;
  }
}

export function createTicketId(id: number): TicketId {
  if (!Number.isFinite(id) || id === 0) {
    throw new HotswapTicketError("ticketIdOutOfRange", { ticketId: id });
  }

  return id as TicketId;
}

export function initSwapStateRT<EngineKind extends number>(
  ticket: SwapTicketRT<EngineKind>,
): SwapStateRT<EngineKind> {
  if (!Number.isFinite(ticket.fadeFrames) || ticket.fadeFrames < 1) {
    throw new HotswapTicketError("fadeFramesNonPositive", ticket);
  }

  if (!Number.isFinite(ticket.preWarmBlocks) || ticket.preWarmBlocks < 0) {
    throw new HotswapTicketError("preWarmBlocksNegative", ticket);
  }

  if (ticket.ticketId === 0) {
    throw new HotswapTicketError("ticketIdOutOfRange", ticket);
  }

  const fadeStepsHint = 16;

  return {
    phase: "spawn",
    hasTicket: true,
    ticket,
    totalFadeFrames: ticket.fadeFrames,
    fadeFramesRemaining: ticket.fadeFrames,
    preWarmBlocksRemaining: ticket.preWarmBlocks,
    stepIndex: 0,
    stepTotal: 2 + ticket.preWarmBlocks + fadeStepsHint + 1,
  };
}

interface FadeGeometry {
  readonly total: number;
  readonly doneStart: number;
  readonly doneEnd: number;
}

function fadeNone(): FadeGeometry {
  return { total: 0, doneStart: 0, doneEnd: 0 };
}

function clampNonNegativeInt(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  return n <= 0 ? 0 : Math.floor(n);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) {
    return 0;
  }
  if (n <= 0) {
    return 0;
  }
  if (n >= 1) {
    return 1;
  }
  return n;
}

export function stepSwapStateRT<EngineKind extends number>(
  state: SwapStateRT<EngineKind>,
  blockFrames: number,
  activeKind: EngineKind,
  nextKind: EngineKind,
  noneKindSentinel: EngineKind,
): SwapStepDecisionRT<EngineKind> {
  const safeBlockFrames = clampNonNegativeInt(blockFrames);
  const ticketId: number = state.hasTicket ? state.ticket.ticketId : 0;
  const progress =
    state.stepTotal > 0 ? clamp01(state.stepIndex / state.stepTotal) : 0;

  const mkStatus = (
    phase: SwapPhase,
    activeEngineKind: EngineKind,
    nextEngineKind: EngineKind,
    fade: FadeGeometry,
    preWarmBlocksRemaining: number,
  ): SwapStatusRT<EngineKind> => ({
    phase,
    ticketId,
    progress,
    activeEngineKind,
    nextEngineKind,
    fadeTotalFrames: fade.total,
    fadeDoneFramesAtBlockStart: fade.doneStart,
    fadeDoneFramesAtBlockEnd: fade.doneEnd,
    preWarmBlocksRemaining,
  });

  if (!state.hasTicket || state.phase === "idle") {
    return {
      kind: "idle",
      status: mkStatus("idle", activeKind, noneKindSentinel, fadeNone(), 0),
    };
  }

  switch (state.phase) {
    case "spawn": {
      state.phase = "prime";
      state.stepIndex += 1;
      return {
        kind: "runCurrentOnly",
        status: mkStatus(
          "spawn",
          activeKind,
          nextKind,
          fadeNone(),
          state.preWarmBlocksRemaining,
        ),
      };
    }

    case "prime": {
      state.phase = state.preWarmBlocksRemaining > 0 ? "prewarm" : "crossfade";
      state.stepIndex += 1;
      return {
        kind: "runCurrentOnly",
        status: mkStatus(
          "prime",
          activeKind,
          nextKind,
          fadeNone(),
          state.preWarmBlocksRemaining,
        ),
      };
    }

    case "prewarm": {
      const remainingAtStart = state.preWarmBlocksRemaining;
      state.preWarmBlocksRemaining = Math.max(0, remainingAtStart - 1);
      state.stepIndex += 1;

      if (state.preWarmBlocksRemaining === 0) {
        state.phase = "crossfade";
      }

      return {
        kind: "runCurrentAndPrewarmNext",
        status: mkStatus(
          "prewarm",
          activeKind,
          nextKind,
          fadeNone(),
          state.preWarmBlocksRemaining,
        ),
      };
    }

    case "crossfade": {
      const total = state.totalFadeFrames;
      const remainingAtStart = state.fadeFramesRemaining;
      const doneStart = Math.max(0, total - remainingAtStart);
      const remainingAfter = Math.max(0, remainingAtStart - safeBlockFrames);
      state.fadeFramesRemaining = remainingAfter;
      const doneEnd = Math.max(0, total - remainingAfter);

      state.stepIndex += 1;

      if (state.fadeFramesRemaining === 0) {
        state.phase = "retire";
      }

      return {
        kind: "runBothForCrossfade",
        status: mkStatus(
          "crossfade",
          activeKind,
          nextKind,
          { total, doneStart, doneEnd },
          state.preWarmBlocksRemaining,
        ),
      };
    }

    case "retire": {
      state.phase = "idle";
      state.hasTicket = false;
      state.stepIndex += 1;

      return {
        kind: "retireNow",
        status: mkStatus("retire", nextKind, noneKindSentinel, fadeNone(), 0),
      };
    }

    default: {
      const _exhaustive: never = state.phase;
      throw new Error(`Unhandled swap phase: ${String(_exhaustive)}`);
    }
  }
}
