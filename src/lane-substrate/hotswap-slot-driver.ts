import {
  initSwapStateRT,
  stepSwapStateRT,
  type SwapStateRT,
  type SwapStepDecisionRT,
  type SwapTicketRT,
} from "@seqlok/hotswap";

export interface HotswapSlotDriver<EngineKind extends number> {
  readonly hasState: boolean;
  readonly state: SwapStateRT<EngineKind> | null;
  acceptTicket(ticket: SwapTicketRT<EngineKind>): void;
  clear(): void;
  stepBlock(
    blockFrames: number,
    activeKind: EngineKind,
    nextKind: EngineKind,
    noneKindSentinel: EngineKind,
  ): SwapStepDecisionRT<EngineKind>;
}

export function createHotswapSlotDriver<
  EngineKind extends number,
>(): HotswapSlotDriver<EngineKind> {
  let hasState = false;
  let state: SwapStateRT<EngineKind> | null = null;

  return {
    get hasState(): boolean {
      return hasState;
    },

    get state(): SwapStateRT<EngineKind> | null {
      return state;
    },

    acceptTicket(ticket: SwapTicketRT<EngineKind>): void {
      if (hasState && state?.hasTicket) {
        return;
      }
      state = initSwapStateRT(ticket);
      hasState = true;
    },

    clear(): void {
      state = null;
      hasState = false;
    },

    stepBlock(
      blockFrames: number,
      activeKind: EngineKind,
      nextKind: EngineKind,
      noneKindSentinel: EngineKind,
    ): SwapStepDecisionRT<EngineKind> {
      if (!hasState || state === null) {
        return {
          kind: "idle",
          status: {
            phase: "idle",
            ticketId: 0,
            progress: 0,
            activeEngineKind: activeKind,
            nextEngineKind: noneKindSentinel,
            fadeTotalFrames: 0,
            fadeDoneFramesAtBlockStart: 0,
            fadeDoneFramesAtBlockEnd: 0,
            preWarmBlocksRemaining: 0,
          },
        };
      }

      return stepSwapStateRT(
        state,
        blockFrames,
        activeKind,
        nextKind,
        noneKindSentinel,
      );
    },
  };
}
