// File: src/engine/stretch-engine.ts

import type { SignalsmithStretchModule, CBool } from "../../vendor/src";

import type { EngineKind } from "./engine-kind";
import type { StretchParams, StretchStructuralConfig } from "./stretch-config";

export interface StretchEngine {
  readonly kind: EngineKind;

  readonly inputLatencyFrames: number;
  readonly outputLatencyFrames: number;
  readonly totalLatencyFrames: number;

  render(
    dstPerChannel: Float32Array[],
    frames: number,
    params: StretchParams,
  ): void;
}

export interface StretchEngineInstanceOptions {
  readonly kind: EngineKind;
  readonly module: SignalsmithStretchModule;
  readonly structural: StretchStructuralConfig;
  readonly maxBlockSamples: number;
  readonly pullInput: (dstPerChannel: Float32Array[], frames: number) => void;
}

function toCBool(x: boolean): CBool {
  return x ? (1 as CBool) : (0 as CBool);
}

function copyFrames(
  dst: Float32Array,
  src: Float32Array,
  frames: number,
): void {
  for (let i = 0; i < frames; i += 1) {
    dst[i] = src[i] ?? 0;
  }
}

export class StretchEngineInstance implements StretchEngine {
  readonly kind: EngineKind;

  readonly inputLatencyFrames: number;
  readonly outputLatencyFrames: number;
  readonly totalLatencyFrames: number;

  private readonly module: SignalsmithStretchModule;
  private readonly channels: number;
  private readonly maxBlockSamples: number;

  private readonly pullInput: (
    dstPerChannel: Float32Array[],
    frames: number,
  ) => void;

  private readonly inputViews: Float32Array[];
  private readonly outputViews: Float32Array[];

  constructor(options: StretchEngineInstanceOptions) {
    const { kind, module, structural, maxBlockSamples, pullInput } = options;

    this.kind = kind;
    this.module = module;
    this.channels = structural.channels;
    this.maxBlockSamples = maxBlockSamples;
    this.pullInput = pullInput;

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

    // Give buffers enough headroom (avoid any accidental boundary assumptions).
    // This is still a single allocation per engine instance.
    const bufferLength = Math.max(
      maxBlockSamples,
      this.totalLatencyFrames + maxBlockSamples + structural.intervalSamples,
    );

    const { inputViews, outputViews } = this.createViews(
      structural.channels,
      bufferLength,
    );
    this.inputViews = inputViews;
    this.outputViews = outputViews;

    module._reset?.();
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

  render(
    dstPerChannel: Float32Array[],
    frames: number,
    params: StretchParams,
  ): void {
    const { module, channels, maxBlockSamples, inputViews, outputViews } = this;

    if (frames > maxBlockSamples) {
      throw new Error(
        `frames(${frames}) > maxBlockSamples(${maxBlockSamples})`,
      );
    }

    this.pullInput(inputViews, frames);
    this.applyParams(params);

    module._process(frames, frames);

    for (let c = 0; c < channels; c += 1) {
      const src = outputViews[c];
      const dst = dstPerChannel[c];
      if (src === undefined || dst === undefined) continue;
      copyFrames(dst, src, frames);
    }
  }
}
