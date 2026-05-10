import { createLaneRuntime, type LaneRuntime } from "../app/lane-runtime";
import {
  StretchLaneComposite,
  type StretchLaneOptions,
} from "../engine/stretchLane";
import type {
  StretchStructuralConfig,
  StretchParams,
} from "../engine/stretchConfig";
import type { RuntimePcmAsset } from "../transport/pcmAssetTypes";
import {
  createSourceAssetReader,
  type SourceAssetReader,
} from "../transport/sourceAssetReader";
import { createTransportState } from "../transport/transportState";
import { createInputDebtAccumulator } from "../transport/inputDebtAccumulator";
import {
  createPreRollPlanner,
} from "../transport/preRollPlanner";

export interface StretchLaneRuntimeOptions {
  /**
   * Mailbox ID for this lane. In a multi-lane system you'd use
   * something like "lane-0", "lane-1", etc.
   */
  readonly mailboxId: string;

  /**
   * Structural configuration for the stretch engine (channels,
   * block size, quality preset, etc.).
   */
  readonly structural: StretchStructuralConfig;

  /**
   * Initial non-structural parameters (speed, pitch, formants...).
   */
  readonly initialParams: StretchParams;

  /**
   * Where to send the fully mixed lane output.
   */
  readonly pushOutput: (srcPerChannel: Float32Array[], frames: number) => void;
}

export interface StretchLaneRuntime {
  readonly lane: LaneRuntime;
  readonly composite: StretchLaneComposite;

  /**
   * Drive one audio block through:
   *   mailbox → timeline → hotswap → engines → crossfade → pushOutput
   *
   * `outputFrames` MUST be the actual number of output samples in the current
   * render block (e.g. 128 for a standard AudioWorklet quantum).
   */
  processBlock(outputFrames: number): void;

  /**
   * Non-structural live tweaks: speed, pitch, formants, etc.
   */
  updateParams(next: StretchParams): void;

  /**
   * Load a decoded PCM asset into the runtime.
   */
  loadAsset(asset: RuntimePcmAsset): void;

  /**
   * Start or resume playback.
   */
  play(): void;

  /**
   * Pause playback.
   */
  pause(): void;

  /**
   * Seek to a specific source frame.
   */
  seekToFrame(frame: number): void;

  /**
   * Structural change via hotswap.
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
  const { mailboxId, structural, initialParams, pushOutput } = options;

  // 1. Canonical Seqlok lane substrate (mailbox + timeline + slot).
  const lane = createLaneRuntime(mailboxId);

  // 2. Signalsmith composite sitting on top of that lane.
  const compositeOptions: StretchLaneOptions = {
    lane,
    channels: structural.channels,
    blockSamples: structural.blockSamples,
    structural,
    initialParams,
    pushOutput,
  };

  const composite = new StretchLaneComposite(compositeOptions);

  // 3. Transport state
  const transport = createTransportState();

  // 4. Source asset reader
  let reader: SourceAssetReader = createSourceAssetReader(null);

  // 5. Input debt accumulator for fixed-output / variable-input economics
  const debtAccumulator = createInputDebtAccumulator();

  function createPerChannelBuffers(frames: number): Float32Array[] {
    const buffers: Float32Array[] = [];
    for (let c = 0; c < structural.channels; c += 1) {
      buffers.push(new Float32Array(frames));
    }
    return buffers;
  }

  // Canonical input segment reused per render quantum.
  let canonicalInput = createPerChannelBuffers(structural.blockSamples);

  // Pre-roll buffer must be able to exceed steady-state blockSamples.
  let preRollBuffer = createPerChannelBuffers(structural.blockSamples);

  function ensureCanonicalInputCapacity(frames: number): void {
    if ((canonicalInput[0]?.length ?? 0) >= frames) {
      return;
    }
    canonicalInput = createPerChannelBuffers(frames);
  }

  function ensurePreRollCapacity(frames: number): void {
    if ((preRollBuffer[0]?.length ?? 0) >= frames) {
      return;
    }
    preRollBuffer = createPerChannelBuffers(frames);
  }

  function loadAsset(asset: RuntimePcmAsset): void {
    reader = createSourceAssetReader(asset);
    transport.assetId = asset.id;
    transport.sourceFrameCursor = 0;
    transport.inputDebtFrames = 0;
    debtAccumulator.reset();
    transport.phase = "idle";
    transport.pendingPlay = false;
    transport.pendingPause = false;
    transport.pendingSeekFrame = null;
    composite.resetTransport(transport.playbackRate);
  }

  function play(): void {
    if (reader.asset === null) return;
    transport.pendingPlay = true;
    transport.pendingPause = false;
  }

  function pause(): void {
    transport.pendingPause = true;
    transport.pendingPlay = false;
  }

  function seekToFrame(frame: number): void {
    transport.pendingSeekFrame = Math.max(0, Math.floor(frame));
    // If already running, priming will happen on next processBlock.
    // If idle, user must also call play().
  }

  function updateParams(next: StretchParams): void {
    composite.updateParams(next);
    transport.playbackRate = next.speedFactor;
  }

  function performPreRoll(): void {
    if (reader.asset === null) {
      transport.phase = "idle";
      transport.pendingSeekFrame = null;
      return;
    }

    const requiredPreRollFrames = composite.getRequiredPreRollFrames();
    const preRollPlanner = createPreRollPlanner(requiredPreRollFrames);
    const plan = preRollPlanner.computePreRoll(transport, reader);
    const targetFrame = plan.targetFrame;
    const preRollFrames = plan.preRollFrames;

    ensurePreRollCapacity(preRollFrames);

    // Read pre-roll source window. Zero-padded near file start.
    const preRollCursor = Math.max(0, targetFrame - preRollFrames);
    reader.readSegment(preRollBuffer, preRollCursor, preRollFrames);

    // Reset engines
    composite.resetTransport(transport.playbackRate);

    // Pre-roll both engines with the same source window
    composite.preRollAll(preRollBuffer, preRollFrames, transport.playbackRate);

    transport.sourceFrameCursor = targetFrame;
    transport.inputDebtFrames = 0;
    debtAccumulator.reset();
    transport.phase = "running";
    transport.pendingSeekFrame = null;
  }

  function processBlock(outputFrames: number): void {
    // Apply pending pause immediately
    if (transport.pendingPause) {
      transport.phase = "paused";
      transport.pendingPause = false;
      transport.pendingPlay = false;
    }

    // Transition to priming if play or seek is requested
    const shouldPrime =
      transport.pendingPlay ||
      (transport.pendingSeekFrame !== null && transport.phase === "running");

    if (shouldPrime && reader.asset !== null) {
      transport.phase = "priming";
      transport.pendingPlay = false;
    }

    // Execute priming
    if (transport.phase === "priming") {
      performPreRoll();
    }

    // Drive the lane / composite
    if (transport.phase === "running") {
      lane.processBlock(outputFrames, {
        renderWithDecision: (segmentOutputFrames, decision) => {
          const inputFrames = debtAccumulator.accumulate(
            segmentOutputFrames,
            transport.playbackRate,
          );

          ensureCanonicalInputCapacity(inputFrames);

          // Read canonical input segment from source asset
          reader.readSegment(
            canonicalInput,
            transport.sourceFrameCursor,
            inputFrames,
          );

          // Advance cursor
          transport.sourceFrameCursor += inputFrames;

          // Render through composite (both engines see identical input)
          composite.renderSegment(
            segmentOutputFrames,
            decision,
            canonicalInput,
            inputFrames,
          );
        },
      });
    } else {
      // Idle / paused: output silence, but still advance timeline
      lane.processBlock(outputFrames, {
        renderWithDecision: (segmentOutputFrames, _decision) => {
          composite.pushSilence(segmentOutputFrames);
        },
      });
    }
  }

  async function reconfigureStructurally(
    nextStructural: StretchStructuralConfig,
    fadeFrames: number,
    prewarmLeadInFrames: number,
  ): Promise<void> {
    await composite.reconfigureStructurally(
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
    loadAsset,
    play,
    pause,
    seekToFrame,
    reconfigureStructurally,
  };
}
