import { createCommandMailbox } from "@seqlok/commands";
import {
  createHotswapCommandCodec,
  HOTSWAP_COMMAND_TAG_INSTALL,
  HOTSWAP_COMMAND_WORDS_PER_SLOT,
  type HotswapCommand,
} from "./hotswap-command";
import {
  type HotswapSchedulerConfig,
} from "./hotswap-scheduler";
import {
  type SwapTicketRT,
} from "./hotswap-protocol";

import {
  createHotswapSlotDriver,
  type HotswapSlotDriver,
} from "./hotswap-slot-driver";
import type { TimelineCommand, TimelineDriver } from "./timeline-driver";
import { createSlicerState } from "./timeline-slicer";

export interface LaneRuntimeCore<EngineKindEnum extends number> {
  readonly mailbox: {
    readonly producer: ReturnType<typeof createCommandMailbox>["producer"];
    readonly consumer: ReturnType<typeof createCommandMailbox>["consumer"];
  };
  readonly timeline: TimelineDriver<EngineKindEnum>;
  readonly hotswapSlot: HotswapSlotDriver<EngineKindEnum>;
  readonly schedulerConfig: HotswapSchedulerConfig<
    EngineKindEnum,
    HotswapCommand<EngineKindEnum>
  >;
}

/**
 * Canonical lane substrate:
 *
 * - allocates a command mailbox for the lane
 * - wires a TimelineDriver to a HotswapSlotDriver
 * - builds a HotswapSchedulerConfig that enqueues install-swap commands
 * - defines the lane-busy policy (non-idle swap state means busy)
 */
export function createLaneRuntimeCore<EngineKindEnum extends number>(
  mailboxId: string,
): LaneRuntimeCore<EngineKindEnum> {
  const codec = createHotswapCommandCodec<EngineKindEnum>();

  const mailbox = createCommandMailbox<HotswapCommand<EngineKindEnum>>({
    mailboxId,
    codec,
    layout: {
      capacity: 16,
      wordsPerSlot: HOTSWAP_COMMAND_WORDS_PER_SLOT,
    },
  });

  const hotswapSlot = createHotswapSlotDriver<EngineKindEnum>();

  const timeline: TimelineDriver<EngineKindEnum> = {
    frame: 0,
    isPlaying: true,
    slicer: createSlicerState<TimelineCommand<EngineKindEnum>>(),
    hotswapSlot,
  };

  const schedulerConfig: HotswapSchedulerConfig<
    EngineKindEnum,
    HotswapCommand<EngineKindEnum>
  > = {
    mailboxId,
    producer: mailbox.producer,
    encodeInstallSwap(
      ticket: SwapTicketRT<EngineKindEnum>,
    ): HotswapCommand<EngineKindEnum> {
      return {
        tag: HOTSWAP_COMMAND_TAG_INSTALL,
        ticket,
      };
    },
    isLaneBusy(): boolean {
      const state = hotswapSlot.state;
      if (state === null) {
        return false;
      }
      return state.phase !== "idle";
    },
  };

  return {
    mailbox: {
      producer: mailbox.producer,
      consumer: mailbox.consumer,
    },
    timeline,
    hotswapSlot,
    schedulerConfig,
  };
}
