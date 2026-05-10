import { createModule } from "../../vendor/src";

import type { LaneRuntime } from "../app/lane-runtime";
import { EngineKind, type EngineKind as EngineKindType } from "./engineKind";
import { type EngineBank, SimpleEngineBank } from "./engineBank";
import type { StretchParams, StretchStructuralConfig } from "./stretchConfig";

import {
  createTicketId,
  scheduleSwap,
  type SwapStepDecisionRT,
  type SwapTicketRT,
} from "@seqlok/hotswap";

import { type StretchEngine, StretchEngineInstance } from "./stretchEngine";

export interface StretchLaneOptions {
  readonly lane: LaneRuntime;
  readonly channels: number;
  readonly blockSamples: number;

  readonly structural: StretchStructuralConfig;
  readonly initialParams: StretchParams;

  readonly pushOutput: (srcPerChannel: Float32Array[], frames: number) => void;
}

export interface StretchLaneTelemetrySnapshot {
  readonly phase: string;
  readonly mixTo: number;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function cloneParams(p: StretchParams): StretchParams {
  return {
    pitchSemitones: p.pitchSemitones,
    tonalityLimit: p.tonalityLimit,
    formantSemitones: p.formantSemitones,
    formantCompensate: p.formantCompensate,
    formantBaseHz: p.formantBaseHz,
    speedFactor: p.speedFactor,
  };
}

function generateTicketIdNumber(): number {
  generateTicketIdNumber.counter += 1;
  return generateTicketIdNumber.counter;
}
generateTicketIdNumber.counter = 1;

class DelayLine {
  private readonly buf: Float32Array;
  private wr = 0;
  private readonly mask: number;

  constructor(maxDelayFrames: number, safetyFrames: number) {
    let size = 1;
    const need = maxDelayFrames + safetyFrames;
    while (size < need) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }

  reset(): void {
    this.buf.fill(0);
    this.wr = 0;
  }

  process(
    src: Float32Array,
    dst: Float32Array,
    frames: number,
    delayFrames: number,
  ): void {
    let wr = this.wr;
    const { buf, mask } = this;
    const d = Math.max(0, delayFrames | 0);

    for (let i = 0; i < frames; i += 1) {
      const v = src[i] ?? 0;
      buf[wr] = v;
      dst[i] = buf[(wr - d) & mask] ?? 0;
      wr = (wr + 1) & mask;
    }

    this.wr = wr;
  }
}

export class StretchLaneComposite {
  private readonly lane: LaneRuntime;
  private readonly bank: EngineBank;

  private readonly channels: number;
  private readonly blockSamples: number;
  private maxIntervalSamples: number;

  private readonly pushOutput: (
    srcPerChannel: Float32Array[],
    frames: number,
  ) => void;

  private readonly outA: Float32Array[];
  private readonly outB: Float32Array[];

  private readonly alignedA: Float32Array[];
  private readonly alignedB: Float32Array[];
  private readonly mixOut: Float32Array[];

  private readonly delayA: DelayLine[];
  private readonly delayB: DelayLine[];

  // High-water mark: never decrease while running.
  private laneDelayFrames = 0;

  private liveParams: StretchParams;
  private swapParams: StretchParams | null = null;

  private telemetryPhase: string = "idle";
  private telemetryMixTo = 0;

  private lastQuantumFrames = 128;
  private currentActiveKind: EngineKindType = EngineKind.A;

  constructor(options: StretchLaneOptions) {
    const {
      lane,
      channels,
      blockSamples,
      structural,
      initialParams,
      pushOutput,
    } = options;

    this.lane = lane;
    this.channels = channels;
    this.blockSamples = blockSamples;
    this.maxIntervalSamples = structural.intervalSamples;

    this.pushOutput = pushOutput;

    this.liveParams = initialParams;

    this.bank = new SimpleEngineBank();

    const outA: Float32Array[] = [];
    const outB: Float32Array[] = [];
    const alignedA: Float32Array[] = [];
    const alignedB: Float32Array[] = [];
    const mixOut: Float32Array[] = [];
    const delayA: DelayLine[] = [];
    const delayB: DelayLine[] = [];

    // Must exceed any realistic latency delta (increase if you ever see pad > this).
    const MAX_DELAY = 131072;
    const safety = blockSamples * 4;

    for (let c = 0; c < channels; c += 1) {
      outA.push(new Float32Array(blockSamples));
      outB.push(new Float32Array(blockSamples));

      alignedA.push(new Float32Array(blockSamples));
      alignedB.push(new Float32Array(blockSamples));
      mixOut.push(new Float32Array(blockSamples));

      delayA.push(new DelayLine(MAX_DELAY, safety));
      delayB.push(new DelayLine(MAX_DELAY, safety));
    }

    this.outA = outA;
    this.outB = outB;
    this.alignedA = alignedA;
    this.alignedB = alignedB;
    this.mixOut = mixOut;

    this.delayA = delayA;
    this.delayB = delayB;

    void this.spawnInitialEngines(structural);
  }

  getTelemetrySnapshot(): StretchLaneTelemetrySnapshot {
    return { phase: this.telemetryPhase, mixTo: this.telemetryMixTo };
  }

  getMaxLatencyFrames(): number {
    return this.laneDelayFrames;
  }

  getRequiredPreRollFrames(): number {
    return Math.max(
      this.blockSamples + this.maxIntervalSamples,
      this.laneDelayFrames,
    );
  }

  getMaxActiveInputLatency(): number {
    let max = 0;
    for (const engine of [
      this.bank.get(EngineKind.A),
      this.bank.get(EngineKind.B),
    ]) {
      if (engine) max = Math.max(max, engine.inputLatencyFrames);
    }
    return max;
  }

  getMaxActiveOutputLatency(): number {
    let max = 0;
    for (const engine of [
      this.bank.get(EngineKind.A),
      this.bank.get(EngineKind.B),
    ]) {
      if (engine) max = Math.max(max, engine.outputLatencyFrames);
    }
    return max;
  }

  updateParams(next: StretchParams): void {
    this.liveParams = next;
  }

  resetTransport(playbackRate: number): void {
    this.swapParams = null;
    this.telemetryPhase = "idle";
    this.telemetryMixTo = 0;

    this.resetDelayForKind(EngineKind.A);
    this.resetDelayForKind(EngineKind.B);

    this.bank.get(EngineKind.A)?.resetTransport(playbackRate);
    this.bank.get(EngineKind.B)?.resetTransport(playbackRate);
  }

  preRollAll(
    canonicalInput: Float32Array[],
    inputFrames: number,
    playbackRate: number,
  ): void {
    const a = this.bank.get(EngineKind.A);
    const b = this.bank.get(EngineKind.B);
    if (a) a.preRoll(canonicalInput, inputFrames, playbackRate);
    if (b) b.preRoll(canonicalInput, inputFrames, playbackRate);
  }

  async reconfigureStructurally(
    nextStructural: StretchStructuralConfig,
    fadeFrames: number,
    prewarmLeadInFrames: number,
  ): Promise<void> {
    const module = await createModule();

    const nextKind: EngineKindType =
      this.currentActiveKind === EngineKind.A ? EngineKind.B : EngineKind.A;

    const engine = new StretchEngineInstance({
      kind: nextKind,
      module,
      structural: nextStructural,
      maxProcessFrames: this.blockSamples,
    });

    if (nextStructural.intervalSamples > this.maxIntervalSamples) {
      this.maxIntervalSamples = nextStructural.intervalSamples;
    }

    this.bank.register(engine);

    // Update ALC target (high-water mark).
    if (engine.totalLatencyFrames > this.laneDelayFrames) {
      this.laneDelayFrames = engine.totalLatencyFrames;
    }

    // Derived minimum: give the next engine enough lead-in that:
    // - its own latency is fully "filled"
    // - plus one interval of safety (helps preset/state settle)
    const derivedMinLeadIn =
      this.laneDelayFrames + nextStructural.intervalSamples;

    const leadInFrames = Math.max(prewarmLeadInFrames, derivedMinLeadIn);
    const quantum = Math.max(1, this.lastQuantumFrames);
    const preWarmBlocks = Math.max(0, Math.ceil(leadInFrames / quantum));

    const ticket: SwapTicketRT<EngineKindType> = {
      ticketId: createTicketId(generateTicketIdNumber()),
      engineKind: nextKind,
      atFrame: this.lane.timeline.frame,
      fadeFrames,
      preWarmBlocks,
    };

    const result = scheduleSwap(this.lane.schedulerConfig, ticket);
    if (!result.accepted) {
      console.warn("Lane busy, dropping hotswap ticket.", { ticket, result });
      return;
    }

    // Snapshot params for the swap window (prewarm + crossfade).
    this.swapParams = cloneParams(this.liveParams);

    // Reset delay history for the slot we're overwriting.
    this.resetDelayForKind(nextKind);
  }

  private resetDelayForKind(kind: EngineKindType): void {
    const lines = kind === EngineKind.A ? this.delayA : this.delayB;
    for (const d of lines) d.reset();
  }

  private async spawnInitialEngines(
    structural: StretchStructuralConfig,
  ): Promise<void> {
    const moduleA = await createModule();
    const engineA = new StretchEngineInstance({
      kind: EngineKind.A,
      module: moduleA,
      structural,
      maxProcessFrames: this.blockSamples,
    });

    const moduleB = await createModule();
    const engineB = new StretchEngineInstance({
      kind: EngineKind.B,
      module: moduleB,
      structural,
      maxProcessFrames: this.blockSamples,
    });

    this.bank.register(engineA);
    this.bank.register(engineB);

    this.laneDelayFrames = Math.max(
      engineA.totalLatencyFrames,
      engineB.totalLatencyFrames,
    );
  }

  private updateTelemetry(decision: SwapStepDecisionRT<EngineKindType>): void {
    this.telemetryPhase = decision.status.phase;
    this.currentActiveKind = decision.status.activeEngineKind;

    if (
      decision.status.phase === "crossfade" &&
      decision.status.fadeTotalFrames > 0
    ) {
      this.telemetryMixTo = clamp01(
        decision.status.fadeDoneFramesAtBlockEnd /
          decision.status.fadeTotalFrames,
      );
    } else if (decision.kind === "retireNow") {
      this.telemetryMixTo = 1;
    } else {
      this.telemetryMixTo = 0;
    }

    if (decision.status.phase === "idle") {
      this.swapParams = null;
    }
  }

  private selectParams(decision: SwapStepDecisionRT<EngineKindType>): StretchParams {
    return this.swapParams !== null && decision.status.phase !== "idle"
      ? this.swapParams
      : this.liveParams;
  }

  renderSegment(
    outputFrames: number,
    decision: SwapStepDecisionRT<EngineKindType>,
    canonicalInput: Float32Array[],
    inputFrames: number,
  ): void {
    this.updateTelemetry(decision);

    const params = this.selectParams(decision);

    const active: StretchEngine | null = this.bank.get(
      decision.status.activeEngineKind,
    );
    const next: StretchEngine | null = this.bank.get(
      decision.status.nextEngineKind,
    );

    // 1) Render raw
    if (active !== null) {
      active.render(this.outA, canonicalInput, inputFrames, outputFrames, params);
    } else {
      for (let c = 0; c < this.channels; c += 1)
        this.outA[c]?.fill(0, 0, outputFrames);
    }

    const runNext =
      decision.kind === "runCurrentAndPrewarmNext" ||
      decision.kind === "runBothForCrossfade";

    if (runNext && next !== null) {
      next.render(this.outB, canonicalInput, inputFrames, outputFrames, params);
    } else {
      for (let c = 0; c < this.channels; c += 1)
        this.outB[c]?.fill(0, 0, outputFrames);
    }

    // 2) ALC alignment
    const latA = active?.totalLatencyFrames ?? 0;
    const latB = next?.totalLatencyFrames ?? 0;

    const padA = Math.max(0, this.laneDelayFrames - latA);
    const padB = Math.max(0, this.laneDelayFrames - latB);

    for (let c = 0; c < this.channels; c += 1) {
      this.delayA[c]!.process(this.outA[c]!, this.alignedA[c]!, outputFrames, padA);
      this.delayB[c]!.process(this.outB[c]!, this.alignedB[c]!, outputFrames, padB);
    }

    // 3) Mix/output
    if (
      decision.kind === "runBothForCrossfade" &&
      next !== null &&
      decision.status.fadeTotalFrames > 0
    ) {
      const total = decision.status.fadeTotalFrames;
      const done0 = decision.status.fadeDoneFramesAtBlockStart;

      for (let c = 0; c < this.channels; c += 1) {
        const aBuf = this.alignedA[c]!;
        const bBuf = this.alignedB[c]!;
        const dst = this.mixOut[c]!;

        for (let i = 0; i < outputFrames; i += 1) {
          const t = clamp01((done0 + i) / total);
          dst[i] = (1 - t) * aBuf[i]! + t * bBuf[i]!;
        }
      }

      this.pushOutput(this.mixOut, outputFrames);
      return;
    }

    // Prewarm or normal: output active only
    this.pushOutput(this.alignedA, outputFrames);
  }

  flushSegment(
    outputFrames: number,
    decision: SwapStepDecisionRT<EngineKindType>,
  ): void {
    this.updateTelemetry(decision);

    const active: StretchEngine | null = this.bank.get(
      decision.status.activeEngineKind,
    );
    const next: StretchEngine | null = this.bank.get(
      decision.status.nextEngineKind,
    );

    // 1) Flush raw
    if (active !== null) {
      active.flush(this.outA, outputFrames);
    } else {
      for (let c = 0; c < this.channels; c += 1)
        this.outA[c]?.fill(0, 0, outputFrames);
    }

    const runNext =
      decision.kind === "runCurrentAndPrewarmNext" ||
      decision.kind === "runBothForCrossfade";

    if (runNext && next !== null) {
      next.flush(this.outB, outputFrames);
    } else {
      for (let c = 0; c < this.channels; c += 1)
        this.outB[c]?.fill(0, 0, outputFrames);
    }

    // 2) ALC alignment
    const latA = active?.totalLatencyFrames ?? 0;
    const latB = next?.totalLatencyFrames ?? 0;

    const padA = Math.max(0, this.laneDelayFrames - latA);
    const padB = Math.max(0, this.laneDelayFrames - latB);

    for (let c = 0; c < this.channels; c += 1) {
      this.delayA[c]!.process(this.outA[c]!, this.alignedA[c]!, outputFrames, padA);
      this.delayB[c]!.process(this.outB[c]!, this.alignedB[c]!, outputFrames, padB);
    }

    // 3) Mix/output
    if (
      decision.kind === "runBothForCrossfade" &&
      next !== null &&
      decision.status.fadeTotalFrames > 0
    ) {
      const total = decision.status.fadeTotalFrames;
      const done0 = decision.status.fadeDoneFramesAtBlockStart;

      for (let c = 0; c < this.channels; c += 1) {
        const aBuf = this.alignedA[c]!;
        const bBuf = this.alignedB[c]!;
        const dst = this.mixOut[c]!;

        for (let i = 0; i < outputFrames; i += 1) {
          const t = clamp01((done0 + i) / total);
          dst[i] = (1 - t) * aBuf[i]! + t * bBuf[i]!;
        }
      }

      this.pushOutput(this.mixOut, outputFrames);
      return;
    }

    // Prewarm or normal: output active only
    this.pushOutput(this.alignedA, outputFrames);
  }

  pushSilence(outputFrames: number): void {
    for (let c = 0; c < this.channels; c += 1) {
      this.alignedA[c]?.fill(0, 0, outputFrames);
    }
    this.pushOutput(this.alignedA, outputFrames);
  }
}
