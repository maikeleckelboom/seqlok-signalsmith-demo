import type { CommandProducer, CommandConsumer } from "@seqlok/commands";
import {
  createLaneRuntimeCore,
  processTimelineBlock,
  drainHotswapMailboxIntoTimeline,
  type HotswapSlotDriver,
  type TimelineCommand,
  type TimelineDriver,
  type TimelineProcessCallbacks,
} from "@seqlok/integration";
import type {
  HotswapCommand,
  HotswapSchedulerConfig,
  SwapStepDecisionRT,
} from "@seqlok/hotswap";

import {
  EngineKind,
  type EngineKind as EngineKindId,
} from "../engine/engine-kind";

/**
 * Host-side view of the Seqlok lane:
 * - mailbox producer/consumer
 * - scheduler config for scheduleSwap(...)
 * - timeline driver + hotswap slot
 * - per-block process entrypoint
 */
export interface LaneRuntime {
  readonly mailboxProducer: CommandProducer<HotswapCommand<EngineKindId>>;
  readonly mailboxConsumer: CommandConsumer<HotswapCommand<EngineKindId>>;

  readonly schedulerConfig: HotswapSchedulerConfig<
    EngineKindId,
    HotswapCommand<EngineKindId>
  >;

  readonly timeline: TimelineDriver<EngineKindId>;
  readonly hotswapSlot: HotswapSlotDriver<EngineKindId>;

  processBlock(blockFrames: number, callbacks: LaneRenderCallbacks): void;
}

export interface LaneRenderCallbacks {
  renderWithDecision(
    frames: number,
    decision: SwapStepDecisionRT<EngineKindId>,
  ): void;

  onTimelineCommandCommitted?(command: TimelineCommand<EngineKindId>): void;
}

export function createLaneRuntime(mailboxId: string): LaneRuntime {
  const { mailbox, timeline, hotswapSlot, schedulerConfig } =
    createLaneRuntimeCore<EngineKindId>(mailboxId);

  const pendingRTCommands: TimelineCommand<EngineKindId>[] = [];
  let activeEngineKind: EngineKindId = EngineKind.A;

  function processBlock(
    blockFrames: number,
    callbacks: LaneRenderCallbacks,
  ): void {
    // Drain mailbox → timeline commands for this block.
    const drained = drainHotswapMailboxIntoTimeline<EngineKindId>({
      mailboxConsumer: mailbox.consumer as CommandConsumer<
        HotswapCommand<EngineKindId>
      >,
      pendingCommands: pendingRTCommands,
      timeline,
      blockFrames,
    });

    const timelineCallbacks: TimelineProcessCallbacks<EngineKindId> = {
      renderSegment(frames: number): void {
        const currentNextKind: EngineKindId = timeline.hotswapSlot.hasState
          ? (timeline.hotswapSlot.state?.ticket.engineKind ?? EngineKind.None)
          : EngineKind.None;

        const decision = timeline.hotswapSlot.stepBlock(
          frames,
          activeEngineKind,
          currentNextKind,
          EngineKind.None,
        );

        if (decision.kind === "retireNow") {
          activeEngineKind = currentNextKind;
        }

        callbacks.renderWithDecision(frames, decision);
      },

      applyCommandSideEffects(cmd: TimelineCommand<EngineKindId>): void {
        if (callbacks.onTimelineCommandCommitted !== undefined) {
          callbacks.onTimelineCommandCommitted(cmd);
        }
      },
    };

    processTimelineBlock(timeline, blockFrames, drained, timelineCallbacks);
  }

  return {
    mailboxProducer: mailbox.producer as CommandProducer<
      HotswapCommand<EngineKindId>
    >,
    mailboxConsumer: mailbox.consumer as CommandConsumer<
      HotswapCommand<EngineKindId>
    >,
    schedulerConfig,
    timeline,
    hotswapSlot,
    processBlock,
  };
}
