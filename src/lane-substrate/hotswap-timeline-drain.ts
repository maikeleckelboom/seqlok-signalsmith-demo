import type { CommandConsumer } from "@seqlok/commands";

import type { HotswapCommand } from "./hotswap-command";
import type { TimelineCommand, TimelineDriver } from "./timeline-driver";

export interface HotswapDrainContext<K extends number> {
  readonly mailboxConsumer: CommandConsumer<HotswapCommand<K>>;
  readonly pendingCommands: TimelineCommand<K>[];
  readonly timeline: TimelineDriver<K>;
  readonly blockFrames: number;
}

/**
 * Drain the hotswap mailbox into `pendingCommands`, then extract the subset
 * of commands which apply to the current block. Commands whose `atFrame` is
 * strictly before the end of the block are considered due and are returned;
 * the rest remain pending.
 *
 * Late commands (atFrame < blockStart) are applied in the first segment of
 * the current block; this matches the timeline-driver edge-case tests.
 */
export function drainHotswapMailboxIntoTimeline<K extends number>(
  context: HotswapDrainContext<K>,
): TimelineCommand<K>[] {
  const { mailboxConsumer, pendingCommands, timeline, blockFrames } = context;

  mailboxConsumer.drain({
    onCommand(command: HotswapCommand<K>): void {
      const { ticket } = command;

      pendingCommands.push({
        atFrame: ticket.atFrame,
        priority: 0,
        payload: {
          kind: "installSwap",
          ticket,
        },
      });
    },
  });

  const blockEnd = timeline.frame + blockFrames;
  const drainedCommands: TimelineCommand<K>[] = [];

  for (let i = pendingCommands.length - 1; i >= 0; i -= 1) {
    const cmd = pendingCommands[i];
    if (cmd === undefined) {
      continue;
    }

    if (cmd.atFrame < blockEnd) {
      drainedCommands.push(cmd);
      pendingCommands.splice(i, 1);
    }
  }

  // Sort by (atFrame, priority) for deterministic behavior.
  drainedCommands.sort((a, b) => {
    if (a.atFrame !== b.atFrame) {
      return a.atFrame - b.atFrame;
    }
    return a.priority - b.priority;
  });

  return drainedCommands;
}
