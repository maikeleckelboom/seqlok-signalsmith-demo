import type { SignalsmithStretchModule, CBool } from "../../vendor/src";

import type { EngineKind } from "./engineKind";
import type { StretchParams, StretchStructuralConfig } from "./stretchConfig";

export interface StretchEngine {
  readonly kind: EngineKind;

  readonly inputLatencyFrames: number;
  readonly outputLatencyFrames: number;
  readonly totalLatencyFrames: number;

  /**
   * Reset internal state (buffers, history) while preserving configuration.
   */
  resetTransport(playbackRate: number): void;

  /**
   * Seek / pre-roll: copy `inputFrames` from `srcPerChannel` into internal
   * input buffers and call `_seek(inputFrames, playbackRate)`.
   */
  preRoll(
    srcPerChannel: Float32Array[],
    inputFrames: number,
    playbackRate: number,
  ): void;

  /**
   * Render one block.
   *
   * Input is copied from `srcPerChannel` (length `inputFrames`).
   * Output is written to `dstPerChannel` (length `outputFrames`).
   */
  render(
    dstPerChannel: Float32Array[],
    srcPerChannel: Float32Array[],
    inputFrames: number,
    outputFrames: number,
    params: StretchParams,
  ): void;
}

export interface StretchEngineInstanceOptions {
  readonly kind: EngineKind;
  readonly module: SignalsmithStretchModule;
  readonly structural: StretchStructuralConfig;
  readonly maxProcessFrames: number;
}

function toCBool(x: boolean): CBool {
  return x ? (1 as CBool) : (0 as CBool);
}

function clampPlaybackRate(x: number): number {
  if (!Number.isFinite(x)) return 1;
  if (x <= 0.0001) return 0.0001;
  return x;
}

export class StretchEngineInstance implements StretchEngine {
  readonly kind: EngineKind;

  readonly inputLatencyFrames: number;
  readonly outputLatencyFrames: number;
  readonly totalLatencyFrames: number;

  private readonly module: SignalsmithStretchModule;
  private readonly channels: number;
  private readonly maxProcessFrames: number;
  private readonly maxInputFrames: number;

  private readonly inputViews: Float32Array[];
  private readonly outputViews: Float32Array[];

  constructor(options: StretchEngineInstanceOptions) {
    const { kind, module, structural, maxProcessFrames } = options;

    this.kind = kind;
    this.module = module;
    this.channels = structural.channels;
    this.maxProcessFrames = maxProcessFrames;

    // Preset first, then configure
    if (structural.preset === "cheaper") {
      module._presetCheaper(structural.channels, structural.sampleRate);
    } else {
      module._presetDefault(structural.channels, structural.sampleRate);
    }

    module._configure(
      structural.channels,
      structural.blockSamples,
      structural.intervalSamples,
      toCBool(structural.splitComputation),
    );

    const inputLatency =
      typeof module._inputLatency === "function" ? module._inputLatency() : 0;
    const outputLatency =
      typeof module._outputLatency === "function" ? module._outputLatency() : 0;

    this.inputLatencyFrames = inputLatency;
    this.outputLatencyFrames = outputLatency;
    this.totalLatencyFrames = inputLatency + outputLatency;

    // Separate steady-state render capacity from seek/pre-roll input capacity.
    // Signalsmith start/seek wants at least block + interval ideally, and
    // start-of-play may also need input-latency coverage.
    const requiredPreRollFrames = Math.max(
      structural.blockSamples + structural.intervalSamples,
      this.inputLatencyFrames,
    );

    this.maxInputFrames = Math.max(
      this.maxProcessFrames,
      requiredPreRollFrames,
    );

    const bufferLength = Math.max(
      this.maxInputFrames,
      this.totalLatencyFrames +
        this.maxProcessFrames +
        structural.intervalSamples,
    );

    const { inputViews, outputViews } = this.createViews(
      structural.channels,
      bufferLength,
    );
    this.inputViews = inputViews;
    this.outputViews = outputViews;

    this.resetTransport(1);
  }

  resetTransport(_playbackRate: number): void {
    this.module._reset?.();

    for (let c = 0; c < this.channels; c += 1) {
      this.outputViews[c]?.fill(0);
    }
  }

  preRoll(
    srcPerChannel: Float32Array[],
    inputFrames: number,
    playbackRate: number,
  ): void {
    const rate = clampPlaybackRate(playbackRate);
    const limit = Math.min(
      inputFrames,
      this.maxInputFrames,
      this.inputViews[0]?.length ?? this.maxInputFrames,
    );

    for (let c = 0; c < this.channels; c += 1) {
      const dst = this.inputViews[c];
      const src = srcPerChannel[c];
      if (dst === undefined) continue;

      if (src !== undefined) {
        const copyLen = Math.min(limit, src.length, dst.length);
        dst.set(src.subarray(0, copyLen), 0);
        if (copyLen < limit) {
          dst.fill(0, copyLen, limit);
        }
      } else {
        dst.fill(0, 0, limit);
      }
    }

    if (limit > 0) {
      this.module._seek(limit, rate);
    }
  }

  render(
    dstPerChannel: Float32Array[],
    srcPerChannel: Float32Array[],
    inputFrames: number,
    outputFrames: number,
    params: StretchParams,
  ): void {
    const {
      module,
      channels,
      maxProcessFrames,
      maxInputFrames,
      inputViews,
      outputViews,
    } = this;

    if (inputFrames > maxInputFrames || outputFrames > maxProcessFrames) {
      throw new Error(
        `inputFrames(${inputFrames}) > maxInputFrames(${maxInputFrames}) or outputFrames(${outputFrames}) > maxProcessFrames(${maxProcessFrames})`,
      );
    }

    // Copy external input into engine input views.
    for (let c = 0; c < channels; c += 1) {
      const dst = inputViews[c];
      const src = srcPerChannel[c];
      if (dst === undefined) continue;

      if (src !== undefined) {
        const copyLen = Math.min(inputFrames, src.length, dst.length);
        dst.set(src.subarray(0, copyLen), 0);
        if (copyLen < inputFrames) {
          dst.fill(0, copyLen, inputFrames);
        }
      } else {
        dst.fill(0, 0, inputFrames);
      }
    }

    this.applyParams(params);

    const playbackRate = clampPlaybackRate(params.speedFactor);
    module._seek(inputFrames, playbackRate);
    module._process(inputFrames, outputFrames);

    for (let c = 0; c < channels; c += 1) {
      const src = outputViews[c];
      const dst = dstPerChannel[c];
      if (src === undefined || dst === undefined) continue;

      const copyLen = Math.min(outputFrames, src.length, dst.length);
      dst.set(src.subarray(0, copyLen), 0);
      if (copyLen < outputFrames) {
        dst.fill(0, copyLen, outputFrames);
      }
    }
  }

  private createViews(
    channels: number,
    bufferLength: number,
  ): { inputViews: Float32Array[]; outputViews: Float32Array[] } {
    const { module } = this;

    const basePtr = module._setBuffers(channels, bufferLength);
    const heapBuffer = module.HEAPF32.buffer;
    const bytesPerSample = 4;

    const inputViews: Float32Array[] = [];
    const outputViews: Float32Array[] = [];

    for (let c = 0; c < channels; c += 1) {
      inputViews[c] = new Float32Array(
        heapBuffer,
        basePtr + bytesPerSample * bufferLength * c,
        bufferLength,
      );
      outputViews[c] = new Float32Array(
        heapBuffer,
        basePtr + bytesPerSample * bufferLength * (channels + c),
        bufferLength,
      );
    }

    return { inputViews, outputViews };
  }

  private applyParams(params: StretchParams): void {
    const { module } = this;

    module._setTransposeSemitones(params.pitchSemitones, params.tonalityLimit);
    module._setFormantSemitones(
      params.formantSemitones,
      toCBool(params.formantCompensate),
    );
    module._setFormantBase(params.formantBaseHz);
  }
}
