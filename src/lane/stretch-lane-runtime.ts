import { createLaneRuntime, type LaneRuntime } from "../app/lane-runtime";
import {
  StretchLaneComposite,
  type StretchLaneOptions,
} from "../engine/stretch-lane";
import type {
  StretchStructuralConfig,
  StretchParams,
} from "../engine/stretch-config";

/**
 * Host-side IO: where audio comes from and where we send the mixed output.
 *
 * The idea is:
 * - pullInput(): read `frames` samples of track audio into per-channel buffers
 * - pushOutput(): receive the fully mixed lane output for `frames`
 */
export interface StretchLaneIo {
  readonly pullInput: (dstPerChannel: Float32Array[], frames: number) => void;
  readonly pushOutput: (srcPerChannel: Float32Array[], frames: number) => void;
}

export interface StretchLaneRuntimeOptions extends StretchLaneIo {
  /**
   * Mailbox ID for this lane. In a multi-lane system you’d use
   * something like "lane-0", "lane-1", etc.
   */
  readonly mailboxId: string;

  /**
   * Structural configuration for the stretch engine (channels,
   * block size, quality preset, etc.).
   *
   * NOTE:
   * - structural.blockSamples is the *maximum* block size the engine/composite
   *   is prepared to handle (and what we use to size internal buffers).
   * - It is NOT the same as the AudioWorklet render quantum.
   */
  readonly structural: StretchStructuralConfig;

  /**
   * Initial non-structural parameters (speed, pitch, formants…).
   */
  readonly initialParams: StretchParams;
}

/**
 * Fully wired stretch lane, ready to be driven from an audio loop.
 *
 * – `processBlock(frames)` is your RT entry point (call once per block).
 * – `updateParams()` is for inexpensive, non-structural changes.
 * – `reconfigureStructurally()` spawns a new engine and schedules a
 *   swap via Seqlok's hotswap protocol.
 */
export interface StretchLaneRuntime {
  readonly lane: LaneRuntime;
  readonly composite: StretchLaneComposite;

  /**
   * Drive one audio block through:
   *   mailbox → timeline → hotswap → engines → crossfade → pushOutput
   *
   * `frames` MUST be the actual number of samples in the current render block
   * (e.g. 128 for a standard AudioWorklet quantum).
   */
  processBlock(frames: number): void;

  /**
   * Non-structural live tweaks: speed, pitch, formants, etc.
   */
  updateParams(next: StretchParams): void;

  /**
   * Structural change via hotswap:
   *   - builds a new Signalsmith engine with `nextStructural`
   *   - primes/prewarms it
   *   - schedules a swap ticket with the given fade + lead-in
   */
  reconfigureStructurally(
    nextStructural: StretchStructuralConfig,
    fadeFrames: number,
    prewarmLeadInFrames: number,
  ): Promise<void>;
}

export function createStretchLaneRuntime(
  options: StretchLaneRuntimeOptions,
): StretchLaneRuntime {
  const { mailboxId, structural, initialParams, pullInput, pushOutput } =
    options;

  // 1. Canonical Seqlok lane substrate (mailbox + timeline + slot).
  const lane = createLaneRuntime(mailboxId);

  // 2. Signalsmith composite sitting on top of that lane.
  const compositeOptions: StretchLaneOptions = {
    lane,
    channels: structural.channels,
    // This is the *max* block size the composite allocates for internally.
    // The actual per-callback `frames` can be smaller (e.g. 128).
    blockSamples: structural.blockSamples,
    structural,
    initialParams,
    pullInput,
    pushOutput,
  };

  const composite = new StretchLaneComposite(compositeOptions);

  function processBlock(frames: number): void {
    // Crucial: pass the *actual* render quantum to the composite/lane.
    composite.processBlock(frames);
  }

  function updateParams(next: StretchParams): void {
    composite.updateParams(next);
  }

  function reconfigureStructurally(
    nextStructural: StretchStructuralConfig,
    fadeFrames: number,
    prewarmLeadInFrames: number,
  ): Promise<void> {
    return composite.reconfigureStructurally(
      nextStructural,
      fadeFrames,
      prewarmLeadInFrames,
    );
  }

  return {
    lane,
    composite,
    processBlock,
    updateParams,
    reconfigureStructurally,
  };
}
