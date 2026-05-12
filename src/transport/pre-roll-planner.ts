import type { SourceAssetReader } from "./source-asset-reader";
import type { TransportState } from "./transport-state";

export interface PreRollPlan {
  readonly targetFrame: number;
  readonly preRollFrames: number;
  readonly preRollInputFrames: number;
}

export interface PreRollPlanner {
  computePreRoll(state: TransportState, asset: SourceAssetReader): PreRollPlan;
}

export function createPreRollPlanner(
  requiredPreRollFrames: number,
): PreRollPlanner {
  const basePreRoll = Math.max(0, requiredPreRollFrames | 0);

  function computePreRoll(
    state: TransportState,
    _asset: SourceAssetReader,
  ): PreRollPlan {
    const targetFrame = state.pendingSeekFrame ?? state.sourceFrameCursor;
    const preRollFrames = basePreRoll;

    // For the seek() call we provide preRollFrames of input,
    // but if we're near the start we may have fewer actual source frames.
    const preRollInputFrames = preRollFrames;

    return {
      targetFrame,
      preRollFrames,
      preRollInputFrames,
    };
  }

  return {
    computePreRoll,
  };
}
