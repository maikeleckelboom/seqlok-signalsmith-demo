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
import { createPreRollPlanner } from "../transport/preRollPlanner";
import {
  invariantCanonicalCapacity,
  invariantFlushDoesNotConsumeInput,
  invariantInputDebtFinite,
  invariantPausedIdleNoCursorAdvance,
  invariantPhaseTransition,
  invariantPreRollCapacity,
  invariantSourceCursorNonNegative,
  clearLastViolations,
} from "../transport/transportInvariants";
import {
  buildTransportTelemetry,
  type TransportTelemetrySnapshot,
} from "../transport/transportTelemetry";

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
   * Current transport phase (idle, running, drainingInput, flushingTail, etc.).
   */
  readonly transportPhase: string;

  /**
   * Snapshot of combined transport + engine telemetry for the current block.
   */
  getTelemetrySnapshot(): TransportTelemetrySnapshot;

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
    transport.endingDrainFramesRemaining = 0;
    transport.endingFlushFramesRemaining = 0;
    composite.resetTransport(transport.playbackRate);
    clearLastViolations();
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
    invariantPreRollCapacity(
      transport,
      preRollBuffer[0]?.length ?? 0,
      preRollFrames,
    );

    // Read pre-roll source window. Zero-padded near file start.
    const preRollCursor = Math.max(0, targetFrame - preRollFrames);
    reader.readSegment(preRollBuffer, preRollCursor, preRollFrames);

    // Reset engines
    composite.resetTransport(transport.playbackRate);

    // Pre-roll both engines with the same source window
    composite.preRollAll(preRollBuffer, preRollFrames, transport.playbackRate);

    transport.sourceFrameCursor = targetFrame;
    invariantSourceCursorNonNegative(transport);
    transport.inputDebtFrames = 0;
    debtAccumulator.reset();
    transport.phase = "running";
    transport.pendingSeekFrame = null;
  }

  // Mutable telemetry accumulator for the current block.
  let telemetryInputFramesThisBlock = 0;
  let telemetryOutputFramesThisBlock = 0;
  let telemetryIsZeroBackedInput = false;

  function processBlock(outputFrames: number): void {
    const previousPhase = transport.phase;

    // Apply pending pause immediately, but never abort an ending tail.
    if (
      transport.pendingPause &&
      transport.phase !== "drainingInput" &&
      transport.phase !== "flushingTail"
    ) {
      transport.phase = "paused";
      transport.pendingPause = false;
      transport.pendingPlay = false;
    }

    // Transition to priming if play or seek is requested.
    // Seek aborts an in-progress ending so the user can jump elsewhere.
    const shouldPrime =
      transport.pendingPlay ||
      (transport.pendingSeekFrame !== null &&
        (transport.phase === "running" ||
          transport.phase === "paused" ||
          transport.phase === "drainingInput" ||
          transport.phase === "flushingTail"));

    if (shouldPrime && reader.asset !== null) {
      transport.phase = "priming";
      transport.pendingPlay = false;
      transport.endingDrainFramesRemaining = 0;
      transport.endingFlushFramesRemaining = 0;
    }

    // Execute priming
    if (transport.phase === "priming") {
      performPreRoll();
    }

    invariantPhaseTransition(previousPhase, transport.phase, transport);

    // Reset per-block telemetry accumulators.
    telemetryInputFramesThisBlock = 0;
    telemetryOutputFramesThisBlock = 0;
    telemetryIsZeroBackedInput = false;

    // Drive the lane / composite with phase-dispatching per-segment callback.
    lane.processBlock(outputFrames, {
      renderWithDecision: (segmentOutputFrames, decision) => {
        const segmentPreviousPhase = transport.phase;
        telemetryOutputFramesThisBlock += segmentOutputFrames;

        switch (transport.phase) {
          case "running": {
            const cursorBefore = transport.sourceFrameCursor;
            const inputFrames = debtAccumulator.accumulate(
              segmentOutputFrames,
              transport.playbackRate,
            );
            invariantInputDebtFinite(transport);

            ensureCanonicalInputCapacity(inputFrames);
            invariantCanonicalCapacity(
              transport,
              canonicalInput[0]?.length ?? 0,
              inputFrames,
            );

            reader.readSegment(
              canonicalInput,
              transport.sourceFrameCursor,
              inputFrames,
            );

            transport.sourceFrameCursor += inputFrames;
            invariantSourceCursorNonNegative(transport);
            invariantPausedIdleNoCursorAdvance(
              transport,
              cursorBefore,
              transport.sourceFrameCursor,
            );

            telemetryInputFramesThisBlock += inputFrames;
            telemetryIsZeroBackedInput = false;

            composite.renderSegment(
              segmentOutputFrames,
              decision,
              canonicalInput,
              inputFrames,
            );

            const asset = reader.asset;
            if (
              asset !== null &&
              transport.sourceFrameCursor >= asset.totalFrames
            ) {
              transport.phase = "drainingInput";
              transport.endingDrainFramesRemaining =
                composite.getMaxActiveInputLatency();
            }
            break;
          }

          case "drainingInput": {
            const inputFrames = debtAccumulator.accumulate(
              segmentOutputFrames,
              transport.playbackRate,
            );
            invariantInputDebtFinite(transport);

            ensureCanonicalInputCapacity(inputFrames);
            invariantCanonicalCapacity(
              transport,
              canonicalInput[0]?.length ?? 0,
              inputFrames,
            );

            for (let c = 0; c < structural.channels; c += 1) {
              canonicalInput[c]?.fill(0, 0, inputFrames);
            }

            composite.renderSegment(
              segmentOutputFrames,
              decision,
              canonicalInput,
              inputFrames,
            );

            telemetryInputFramesThisBlock += inputFrames;
            telemetryIsZeroBackedInput = true;

            transport.endingDrainFramesRemaining -= inputFrames;
            if (transport.endingDrainFramesRemaining <= 0) {
              transport.phase = "flushingTail";
              transport.endingFlushFramesRemaining =
                composite.getMaxActiveOutputLatency();
            }
            break;
          }

          case "flushingTail": {
            invariantFlushDoesNotConsumeInput(transport, 0);
            composite.flushSegment(segmentOutputFrames, decision);

            transport.endingFlushFramesRemaining -= segmentOutputFrames;
            if (transport.endingFlushFramesRemaining <= 0) {
              transport.phase = "idle";
              transport.endingDrainFramesRemaining = 0;
              transport.endingFlushFramesRemaining = 0;
              debtAccumulator.reset();
            }
            break;
          }

          case "idle":
          case "paused":
          case "priming":
          default: {
            invariantPausedIdleNoCursorAdvance(
              transport,
              transport.sourceFrameCursor,
              transport.sourceFrameCursor,
            );
            composite.pushSilence(segmentOutputFrames);
            break;
          }
        }

        invariantPhaseTransition(
          segmentPreviousPhase,
          transport.phase,
          transport,
        );
      },
    });
  }

  function getTelemetrySnapshot(): TransportTelemetrySnapshot {
    const laneTelemetry = composite.getTelemetrySnapshot();
    return buildTransportTelemetry(
      transport,
      laneTelemetry,
      telemetryInputFramesThisBlock,
      telemetryOutputFramesThisBlock,
      telemetryIsZeroBackedInput,
    );
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
    get transportPhase() {
      return transport.phase;
    },
    getTelemetrySnapshot,
    processBlock,
    updateParams,
    loadAsset,
    play,
    pause,
    seekToFrame,
    reconfigureStructurally,
  };
}
