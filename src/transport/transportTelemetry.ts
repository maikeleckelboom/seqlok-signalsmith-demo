import type { TransportState } from "./transportState";
import type { StretchLaneTelemetrySnapshot } from "../engine/stretchLane";

export interface TransportTelemetrySnapshot {
  readonly transportPhase: string;
  readonly sourceFrameCursor: number;
  readonly playbackRate: number;
  readonly inputFramesThisBlock: number;
  readonly outputFramesThisBlock: number;
  readonly endingDrainFramesRemaining: number;
  readonly endingFlushFramesRemaining: number;
  readonly isZeroBackedInput: boolean;
  readonly activeEngineKind: string;
  readonly nextEngineKind: string | null;
}

export function buildTransportTelemetry(
  state: TransportState,
  laneTelemetry: StretchLaneTelemetrySnapshot,
  inputFramesThisBlock: number,
  outputFramesThisBlock: number,
  isZeroBackedInput: boolean,
): TransportTelemetrySnapshot {
  return {
    transportPhase: state.phase,
    sourceFrameCursor: state.sourceFrameCursor,
    playbackRate: state.playbackRate,
    inputFramesThisBlock,
    outputFramesThisBlock,
    endingDrainFramesRemaining: state.endingDrainFramesRemaining,
    endingFlushFramesRemaining: state.endingFlushFramesRemaining,
    isZeroBackedInput,
    activeEngineKind: laneTelemetry.activeEngineKind ?? "none",
    nextEngineKind: laneTelemetry.nextEngineKind ?? null,
  };
}
