/**
 * Timeline driver wiring: slicer + hotswap slot + timeline transport state.
 *
 * A timeline is a single monotonically advancing frame counter with scheduled
 * commands. Applications may interpret a timeline as a lane, track, control
 * lane, etc.
 */

import type { SwapTicketRT, TicketId } from "./hotswap-protocol";

import type { HotswapSlotDriver } from "./hotswap-slot-driver";
import {
  appendCommands,
  type ScheduledCommandBase,
  sliceBlock,
  type SlicerState,
} from "./timeline-slicer";

export interface TimelineCommand<
  EngineKind extends number,
> extends ScheduledCommandBase {
  readonly payload:
    | { readonly kind: "play" }
    | { readonly kind: "stop" }
    | { readonly kind: "seek"; readonly targetFrame: number }
    | {
        readonly kind: "installSwap";
        readonly ticket: SwapTicketRT<EngineKind>;
      }
    | { readonly kind: "cancelSwap"; readonly ticketId: TicketId };
}

/**
 * Driver for a single timeline.
 *
 * - Maintains a frame counter (`frame`) and play/stop state.
 * - Uses the slicer to apply timeline commands sample-accurately.
 * - Delegates engine behavior to callbacks and the hotswap slot driver.
 */
export interface TimelineDriver<EngineKind extends number> {
  /**
   * Absolute frame of the next sample to be rendered on this timeline.
   */
  frame: number;

  /**
   * Logical play/stop state for this timeline.
   */
  isPlaying: boolean;

  /**
   * Per-timeline slicer state for scheduled commands.
   */
  slicer: SlicerState<TimelineCommand<EngineKind>>;

  /**
   * Hotswap slot driver for the timeline's engine pair.
   */
  hotswapSlot: HotswapSlotDriver<EngineKind>;
}

export interface TimelineProcessCallbacks<EngineKind extends number> {
  /**
   * Render `frames` samples under the current timeline / hotswap / engine state.
   */
  renderSegment: (frames: number) => void;

  /**
   * Optional hook to observe commands at exact boundaries.
   */
  applyCommandSideEffects?: (cmd: TimelineCommand<EngineKind>) => void;
}

/**
 * Process a single block for a timeline.
 *
 * @param timeline Timeline driver instance.
 * @param blockFrames Number of frames in this block.
 * @param drainedCommands Commands decoded from the mailbox for this block.
 * @param callbacks Engine / hotswap integration callbacks.
 */
export function processTimelineBlock<EngineKind extends number>(
  timeline: TimelineDriver<EngineKind>,
  blockFrames: number,
  drainedCommands: readonly TimelineCommand<EngineKind>[],
  callbacks: TimelineProcessCallbacks<EngineKind>,
): void {
  const blockStart = timeline.frame;

  // Merge newly drained commands into a pending list.
  timeline.slicer = appendCommands(timeline.slicer, drainedCommands);

  const { segments, nextState } = sliceBlock(
    timeline.slicer,
    blockStart,
    blockFrames,
  );
  timeline.slicer = nextState;

  for (const segment of segments) {
    if (segment.frames > 0) {
      callbacks.renderSegment(segment.frames);
      timeline.frame += segment.frames;
    }

    if (segment.commandsAfter.length > 0) {
      for (const cmd of segment.commandsAfter) {
        applyTimelineCommand(timeline, cmd);
        if (callbacks.applyCommandSideEffects !== undefined) {
          callbacks.applyCommandSideEffects(cmd);
        }
      }
    }
  }
}

function applyTimelineCommand<EngineKind extends number>(
  timeline: TimelineDriver<EngineKind>,
  cmd: TimelineCommand<EngineKind>,
): void {
  const payload = cmd.payload;

  switch (payload.kind) {
    case "play":
      timeline.isPlaying = true;
      break;

    case "stop":
      timeline.isPlaying = false;
      break;

    case "seek":
      timeline.frame = payload.targetFrame;
      break;

    case "installSwap":
      timeline.hotswapSlot.acceptTicket(payload.ticket);
      break;

    case "cancelSwap":
      break;
  }
}
