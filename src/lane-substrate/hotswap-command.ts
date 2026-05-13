import type { CommandCodec, DecodeResult } from "@seqlok/commands";

import type { SwapTicketRT } from "./hotswap-protocol";

export type HotswapCommandTag = 1;

export const HOTSWAP_COMMAND_TAG_INSTALL: HotswapCommandTag = 1;

export interface InstallSwapCommand<EngineKind extends number> {
  readonly tag: HotswapCommandTag;
  readonly ticket: SwapTicketRT<EngineKind>;
}

export type HotswapCommand<EngineKind extends number> =
  InstallSwapCommand<EngineKind>;

export const HOTSWAP_COMMAND_WORDS_PER_SLOT = 6;

const HOTSWAP_INSTALL_COMMAND_TYPE = "hotswap.installSwap";

export function createHotswapCommandCodec<
  EngineKind extends number,
>(): CommandCodec<HotswapCommand<EngineKind>> {
  const wordsPerSlot = HOTSWAP_COMMAND_WORDS_PER_SLOT;

  function encode(
    command: HotswapCommand<EngineKind>,
    dst: Uint32Array,
    wordOffset: number,
  ): void {
    const base = wordOffset;
    const ticket = command.ticket;

    dst[base] = command.tag;
    dst[base + 1] = ticket.ticketId as number;
    dst[base + 2] = ticket.engineKind as number;
    dst[base + 3] = ticket.atFrame;
    dst[base + 4] = ticket.fadeFrames;
    dst[base + 5] = ticket.preWarmBlocks;
  }

  function decode(
    src: Uint32Array,
    wordOffset: number,
  ): DecodeResult<HotswapCommand<EngineKind>> {
    const base = wordOffset;
    const tagRaw = src[base];

    if (tagRaw === undefined) {
      return {
        ok: false,
        error: {
          kind: "invalidPayload",
          commandType: HOTSWAP_INSTALL_COMMAND_TYPE,
          reason: "slot missing tag word",
        },
      };
    }

    if (tagRaw !== HOTSWAP_COMMAND_TAG_INSTALL) {
      return {
        ok: false,
        error: {
          kind: "unknownCommand",
          commandType: `hotswap.tag=${String(tagRaw)}`,
        },
      };
    }

    const ticketIdRaw = src[base + 1];
    const engineKindRaw = src[base + 2];
    const atFrameRaw = src[base + 3];
    const fadeFramesRaw = src[base + 4];
    const preWarmBlocksRaw = src[base + 5];

    if (
      ticketIdRaw === undefined ||
      engineKindRaw === undefined ||
      atFrameRaw === undefined ||
      fadeFramesRaw === undefined ||
      preWarmBlocksRaw === undefined
    ) {
      return {
        ok: false,
        error: {
          kind: "invalidPayload",
          commandType: HOTSWAP_INSTALL_COMMAND_TYPE,
          reason: "slot missing payload words",
        },
      };
    }

    if (ticketIdRaw <= 0) {
      return {
        ok: false,
        error: {
          kind: "invalidPayload",
          commandType: HOTSWAP_INSTALL_COMMAND_TYPE,
          reason: "ticketId must be positive",
        },
      };
    }

    if (fadeFramesRaw <= 0) {
      return {
        ok: false,
        error: {
          kind: "invalidPayload",
          commandType: HOTSWAP_INSTALL_COMMAND_TYPE,
          reason: "fadeFrames must be >= 1",
        },
      };
    }

    return {
      ok: true,
      command: {
        tag: HOTSWAP_COMMAND_TAG_INSTALL,
        ticket: {
          ticketId: ticketIdRaw as SwapTicketRT<EngineKind>["ticketId"],
          engineKind: engineKindRaw as EngineKind,
          atFrame: atFrameRaw,
          fadeFrames: fadeFramesRaw,
          preWarmBlocks: preWarmBlocksRaw,
        },
      },
    };
  }

  return {
    wordsPerSlot,
    encode,
    decode,
  };
}
