import {
  createStretchLaneRuntime,
  type StretchLaneRuntime,
} from "../lane/stretch-lane-runtime";
import type {
  StretchParams,
  StretchStructuralConfig,
} from "../engine/stretch-config";
import type { LoadedPcmAsset, RuntimePcmAsset } from "../transport/pcm-asset-types";

type InboundMessage =
  | { type: "init"; mailboxId: string; structural: StretchStructuralConfig; initialParams: StretchParams }
  | { type: "loadAsset"; asset: LoadedPcmAsset }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seekToFrame"; frame: number }
  | { type: "updateParams"; params: StretchParams }
  | { type: "scheduleSwap"; nextStructural: StretchStructuralConfig; fadeFrames: number; prewarmLeadInFrames: number };

interface TelemetryMessage {
  readonly type: "telemetry";
  readonly timelineFrame: number;
  readonly slotPhase: string;
  readonly mixTo: number;
  readonly blockRms: number;
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
  readonly enginesReady: boolean;
  readonly engineInitError: string | null;
}

type OutboundMessage = TelemetryMessage;

function toRuntimeAsset(asset: LoadedPcmAsset): RuntimePcmAsset {
  return {
    id: asset.id,
    channelCount: asset.channelCount,
    sampleRate: asset.sampleRate,
    totalFrames: asset.totalFrames,
    channels: asset.channelDataSab.map((sab) => new Float32Array(sab)),
  };
}

/**
 * AudioWorklet side of a stretch lane.
 *
 * Hot-path goals:
 * - allocation-free
 * - typed-array bulk copies (set/subarray) over per-sample loops
 * - avoid zero-filling giant buffers beyond the current block
 */
class StretchLaneProcessor extends AudioWorkletProcessor {
  private channels = 2;
  private blockSamples = 128;

  private runtime: StretchLaneRuntime | null = null;

  private outputScratch: Float32Array[] = [];

  constructor() {
    super();

    this.resizeScratch(this.channels, this.blockSamples);

    this.port.onmessage = (event: MessageEvent<InboundMessage>): void => {
      const msg = event.data;
      switch (msg.type) {
        case "init": {
          this.handleInit(msg);
          break;
        }
        case "loadAsset": {
          this.handleLoadAsset(msg);
          break;
        }
        case "play": {
          this.handlePlay();
          break;
        }
        case "pause": {
          this.handlePause();
          break;
        }
        case "seekToFrame": {
          this.handleSeekToFrame(msg);
          break;
        }
        case "updateParams": {
          this.handleUpdateParams(msg);
          break;
        }
        case "scheduleSwap": {
          this.handleScheduleSwap(msg);
          break;
        }
      }
    };
  }

  process(
    _inputs: readonly Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    if (outputs.length === 0) {
      return true;
    }

    const outputChannels = outputs[0];
    if (outputChannels === undefined || outputChannels.length === 0) {
      return true;
    }

    const frames = outputChannels[0]?.length ?? 0;
    if (frames === 0) {
      return true;
    }

    const usedChannels = Math.min(this.channels, outputChannels.length);

    if (this.runtime !== null) {
      this.runtime.processBlock(frames);
    } else {
      for (let c = 0; c < usedChannels; c += 1) {
        const scratch = this.outputScratch[c];
        if (scratch !== undefined) {
          scratch.fill(0, 0, Math.min(frames, scratch.length));
        }
      }
    }

    this.sampleAndPostTelemetry(frames);

    // outputScratch -> outputs
    for (let c = 0; c < usedChannels; c += 1) {
      const outChan = outputChannels[c];
      const scratch = this.outputScratch[c];

      if (outChan === undefined || scratch === undefined) {
        continue;
      }

      const limit = Math.min(frames, outChan.length, scratch.length);
      outChan.set(scratch.subarray(0, limit), 0);

      if (limit < outChan.length) {
        outChan.fill(0, limit, outChan.length);
      }
    }

    return true;
  }

  private handleInit(msg: Extract<InboundMessage, { type: "init" }>): void {
    const { structural, initialParams, mailboxId } = msg;

    this.channels = structural.channels;
    this.blockSamples = structural.blockSamples;

    this.resizeScratch(this.channels, this.blockSamples);

    const self = this;

    this.runtime = createStretchLaneRuntime({
      mailboxId,
      structural,
      initialParams,

      pushOutput(srcPerChannel, frames): void {
        const channelsToUse = Math.min(self.channels, srcPerChannel.length);
        for (let c = 0; c < channelsToUse; c += 1) {
          const src = srcPerChannel[c];
          const dst = self.outputScratch[c];

          if (src === undefined || dst === undefined) {
            continue;
          }

          const limit = Math.min(frames, src.length, dst.length);
          dst.set(src.subarray(0, limit), 0);

          if (limit < frames) {
            dst.fill(0, limit, Math.min(frames, dst.length));
          }
        }
      },
    });
  }

  private handleLoadAsset(msg: Extract<InboundMessage, { type: "loadAsset" }>): void {
    if (this.runtime === null) return;
    this.runtime.loadAsset(toRuntimeAsset(msg.asset));
  }

  private handlePlay(): void {
    if (this.runtime === null) return;
    this.runtime.play();
  }

  private handlePause(): void {
    if (this.runtime === null) return;
    this.runtime.pause();
  }

  private handleSeekToFrame(msg: Extract<InboundMessage, { type: "seekToFrame" }>): void {
    if (this.runtime === null) return;
    this.runtime.seekToFrame(msg.frame);
  }

  private handleUpdateParams(msg: Extract<InboundMessage, { type: "updateParams" }>): void {
    if (this.runtime === null) return;
    this.runtime.updateParams(msg.params);
  }

  private handleScheduleSwap(msg: Extract<InboundMessage, { type: "scheduleSwap" }>): void {
    if (this.runtime === null) return;

    const { nextStructural, fadeFrames, prewarmLeadInFrames } = msg;

    void this.runtime.reconfigureStructurally(
      nextStructural,
      fadeFrames,
      prewarmLeadInFrames,
    );
  }

  private resizeScratch(channels: number, frames: number): void {
    const outputScratch: Float32Array[] = [];

    for (let c = 0; c < channels; c += 1) {
      outputScratch[c] = new Float32Array(frames);
    }

    this.outputScratch = outputScratch;
  }

  private sampleAndPostTelemetry(frames: number): void {
    const runtime = this.runtime;
    if (runtime === null) {
      return;
    }

    const { lane, composite } = runtime;

    const snapshot = composite.getTelemetrySnapshot();
    const slotPhase = snapshot.phase;
    const mixTo = snapshot.mixTo;

    const timelineFrame = lane.timeline.frame;

    let sumSq = 0;
    let count = 0;

    for (let c = 0; c < this.channels; c += 1) {
      const src = this.outputScratch[c];
      if (src === undefined) {
        continue;
      }

      const limit = Math.min(frames, src.length);
      for (let i = 0; i < limit; i += 1) {
        const v = src[i] ?? 0;
        sumSq += v * v;
      }
      count += limit;
    }

    const blockRms = count > 0 ? Math.sqrt(sumSq / count) : 0;

    const transportPhase = runtime.transportPhase;
    const transportSnapshot = runtime.getTelemetrySnapshot();

    const msg: TelemetryMessage = {
      type: "telemetry",
      timelineFrame,
      slotPhase,
      mixTo,
      blockRms,
      transportPhase,
      sourceFrameCursor: transportSnapshot.sourceFrameCursor,
      playbackRate: transportSnapshot.playbackRate,
      inputFramesThisBlock: transportSnapshot.inputFramesThisBlock,
      outputFramesThisBlock: transportSnapshot.outputFramesThisBlock,
      endingDrainFramesRemaining: transportSnapshot.endingDrainFramesRemaining,
      endingFlushFramesRemaining: transportSnapshot.endingFlushFramesRemaining,
      isZeroBackedInput: transportSnapshot.isZeroBackedInput,
      activeEngineKind: transportSnapshot.activeEngineKind,
      nextEngineKind: transportSnapshot.nextEngineKind,
      enginesReady: runtime.enginesReady,
      engineInitError: runtime.engineInitError,
    };

    this.port.postMessage(msg as OutboundMessage);
  }
}

registerProcessor("stretch-lane-processor", StretchLaneProcessor);
