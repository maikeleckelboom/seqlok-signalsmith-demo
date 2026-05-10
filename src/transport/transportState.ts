export type TransportPhase = "idle" | "priming" | "running" | "paused";

export interface TransportState {
  phase: TransportPhase;
  assetId: string | null;
  sourceFrameCursor: number;
  inputDebtFrames: number;
  playbackRate: number;
  pendingSeekFrame: number | null;
  pendingPlay: boolean;
  pendingPause: boolean;
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
  };
}
