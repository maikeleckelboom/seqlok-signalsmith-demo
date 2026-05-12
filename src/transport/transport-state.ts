export type TransportPhase =
  | "idle"
  | "priming"
  | "running"
  | "paused"
  | "drainingInput"
  | "flushingTail";

export interface TransportState {
  phase: TransportPhase;
  assetId: string | null;
  sourceFrameCursor: number;
  inputDebtFrames: number;
  playbackRate: number;
  pendingSeekFrame: number | null;
  pendingPlay: boolean;
  pendingPause: boolean;

  /** Remaining silence-backed input frames to feed after EOF. */
  endingDrainFramesRemaining: number;
  /** Remaining output frames to flush after drain. */
  endingFlushFramesRemaining: number;
}

export function createTransportState(): TransportState {
  return {
    phase: "idle",
    assetId: null,
    sourceFrameCursor: 0,
    inputDebtFrames: 0,
    playbackRate: 1,
    pendingSeekFrame: null,
    pendingPlay: false,
    pendingPause: false,
    endingDrainFramesRemaining: 0,
    endingFlushFramesRemaining: 0,
  };
}
