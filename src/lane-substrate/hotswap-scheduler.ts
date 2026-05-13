import {
  createCommandsError,
  type CommandProducer,
  type CommandPushResult,
  type CommandsError,
} from "@seqlok/commands";

import {
  HotswapTicketError,
  initSwapStateRT,
  type SwapTicketRT,
} from "./hotswap-protocol";

export interface HotswapSchedulerConfig<EngineKind extends number, Command> {
  readonly mailboxId: string;
  readonly producer: CommandProducer<Command>;
  readonly encodeInstallSwap: (ticket: SwapTicketRT<EngineKind>) => Command;
  readonly isLaneBusy?: () => boolean;
}

export interface SwapResult {
  readonly accepted: boolean;
  readonly reason?:
    | "lane-busy"
    | "invalid-ticket"
    | "out-of-range"
    | "internal-error";
  readonly ticketId?: number;
}

function mapPushFailureToCommandsError(
  mailboxId: string,
  result: CommandPushResult,
): CommandsError | null {
  if (result.ok) {
    return null;
  }

  if (result.reason === "mailboxClosed") {
    return createCommandsError("mailboxClosed", { mailboxId });
  }

  return createCommandsError("ringOverflow", {
    mailboxId,
    capacity: result.capacity,
    queued: result.queued,
  });
}

export function scheduleSwap<EngineKind extends number, Command>(
  config: HotswapSchedulerConfig<EngineKind, Command>,
  ticket: SwapTicketRT<EngineKind>,
): SwapResult {
  const ticketId = ticket.ticketId as number;

  if (config.isLaneBusy?.()) {
    return {
      accepted: false,
      reason: "lane-busy",
      ticketId,
    };
  }

  try {
    initSwapStateRT(ticket);
  } catch (error) {
    if (error instanceof HotswapTicketError) {
      return {
        accepted: false,
        reason: "invalid-ticket",
        ticketId,
      };
    }
    throw error;
  }

  const command = config.encodeInstallSwap(ticket);
  const pushResult = config.producer.push(command);
  const commandsError = mapPushFailureToCommandsError(
    config.mailboxId,
    pushResult,
  );

  if (commandsError !== null) {
    throw commandsError;
  }

  return {
    accepted: true,
    ticketId,
  };
}
