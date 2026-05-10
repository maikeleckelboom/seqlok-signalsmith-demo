/**
 * Accumulates fractional input frame debt so that fixed-output,
 * variable-input render economics stay sample-accurate over time.
 */
export interface InputDebtAccumulator {
  debt: number;

  /**
   * For a given output quantum, accumulate debt and return the
   * integer number of input frames to read this quantum.
   */
  accumulate(outputFrames: number, playbackRate: number): number;

  reset(): void;
}

export function createInputDebtAccumulator(): InputDebtAccumulator {
  let debt = 0;

  function accumulate(outputFrames: number, playbackRate: number): number {
    debt += outputFrames * playbackRate;
    const inputFrames = Math.floor(debt);
    debt -= inputFrames;
    return inputFrames;
  }

  function reset(): void {
    debt = 0;
  }

  return {
    get debt() {
      return debt;
    },
    accumulate,
    reset,
  };
}
