import { createModule } from "../../vendor/src";

import type { LaneRuntime } from "../app/lane-runtime";
import { EngineKind, type EngineKind as EngineKindType } from "./engine-kind";
import { type EngineBank, SimpleEngineBank } from "./engine-bank";
import type { StretchParams, StretchStructuralConfig } from "./stretch-config";

import {
  createTicketId,
  scheduleSwap,
  type SwapStepDecisionRT,
  type SwapTicketRT,
} from "@seqlok/hotswap";

import { type StretchEngine, StretchEngineInstance } from "./stretch-engine";

export interface StretchLaneOptions {
  readonly lane: LaneRuntime;
  readonly channels: number;
  readonly blockSamples: number;

  readonly structural: StretchStructuralConfig;
  readonly initialParams: StretchParams;

  readonly pullInput: (dstPerChannel: Float32Array[], frames: number) => void;
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

function copyFrames(
  dst: Float32Array,
  src: Float32Array,
  frames: number,
): void {
  for (let i = 0; i < frames; i += 1) dst[i] = src[i] ?? 0;
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

  private readonly pullInputRaw: (
    dstPerChannel: Float32Array[],
    frames: number,
  ) => void;
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

  // Segment input cache
  private readonly inSeg: Float32Array[];
  private inSegValid = false;

  private liveParams: StretchParams;
  private swapParams: StretchParams | null = null;

  private telemetryPhase: string = "idle";
  private telemetryMixTo = 0;

  private lastQuantumFrames = 128;
  private currentActiveKind: EngineKindType = EngineKind.A;

  private readonly laneCallbacks: {
    readonly renderWithDecision: (
      frames: number,
      decision: SwapStepDecisionRT<EngineKindType>,
    ) => void;
  };

  constructor(options: StretchLaneOptions) {
    const {
      lane,
      channels,
      blockSamples,
      structural,
      initialParams,
      pullInput,
      pushOutput,
    } = options;

    this.lane = lane;
    this.channels = channels;
    this.blockSamples = blockSamples;

    this.pullInputRaw = pullInput;
    this.pushOutput = pushOutput;

    this.liveParams = initialParams;

    this.bank = new SimpleEngineBank();

    const outA: Float32Array[] = [];
    const outB: Float32Array[] = [];
    const alignedA: Float32Array[] = [];
    const alignedB: Float32Array[] = [];
    const mixOut: Float32Array[] = [];
    const inSeg: Float32Array[] = [];
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

      inSeg.push(new Float32Array(blockSamples));

      delayA.push(new DelayLine(MAX_DELAY, safety));
      delayB.push(new DelayLine(MAX_DELAY, safety));
    }

    this.outA = outA;
    this.outB = outB;
    this.alignedA = alignedA;
    this.alignedB = alignedB;
    this.mixOut = mixOut;

    this.inSeg = inSeg;

    this.delayA = delayA;
    this.delayB = delayB;

    this.laneCallbacks = {
      renderWithDecision: (frames, decision) =>
        this.renderSegment(frames, decision),
    };

    void this.spawnInitialEngines(structural);
  }

  getTelemetrySnapshot(): StretchLaneTelemetrySnapshot {
    return { phase: this.telemetryPhase, mixTo: this.telemetryMixTo };
  }

  processBlock(blockFrames: number): void {
    this.lastQuantumFrames = Math.max(1, blockFrames);
    this.lane.processBlock(blockFrames, this.laneCallbacks);
  }

  updateParams(next: StretchParams): void {
    this.liveParams = next;
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
      maxBlockSamples: this.blockSamples,
      pullInput: (dst, frames) => this.pullInputCached(dst, frames),
    });

    this.bank.register(engine);

    // Update ALC target (high-water mark).
    if (engine.totalLatencyFrames > this.laneDelayFrames) {
      this.laneDelayFrames = engine.totalLatencyFrames;
    }

    // Derived minimum: give the next engine enough lead-in that:
    // - its own latency is fully “filled”
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

    // Reset delay history for the slot we’re overwriting (so pad changes don’t leak old audio).
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
      maxBlockSamples: this.blockSamples,
      pullInput: (dst, frames) => this.pullInputCached(dst, frames),
    });

    const moduleB = await createModule();
    const engineB = new StretchEngineInstance({
      kind: EngineKind.B,
      module: moduleB,
      structural,
      maxBlockSamples: this.blockSamples,
      pullInput: (dst, frames) => this.pullInputCached(dst, frames),
    });

    this.bank.register(engineA);
    this.bank.register(engineB);

    this.laneDelayFrames = Math.max(
      engineA.totalLatencyFrames,
      engineB.totalLatencyFrames,
    );
  }

  private pullInputCached(dstPerChannel: Float32Array[], frames: number): void {
    if (!this.inSegValid) {
      this.pullInputRaw(this.inSeg, frames);
      this.inSegValid = true;
    }

    for (let c = 0; c < this.channels; c += 1) {
      const dst = dstPerChannel[c];
      const src = this.inSeg[c];
      if (dst !== undefined && src !== undefined) {
        copyFrames(dst, src, frames);
      }
    }
  }

  private renderSegment(
    frames: number,
    decision: SwapStepDecisionRT<EngineKindType>,
  ): void {
    this.inSegValid = false;

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

    const params =
      this.swapParams !== null && decision.status.phase !== "idle"
        ? this.swapParams
        : this.liveParams;

    const active: StretchEngine | null = this.bank.get(
      decision.status.activeEngineKind,
    );
    const next: StretchEngine | null = this.bank.get(
      decision.status.nextEngineKind,
    );

    // 1) Render raw
    if (active !== null) {
      active.render(this.outA, frames, params);
    } else {
      for (let c = 0; c < this.channels; c += 1)
        this.outA[c]?.fill(0, 0, frames);
    }

    const runNext =
      decision.kind === "runCurrentAndPrewarmNext" ||
      decision.kind === "runBothForCrossfade";

    if (runNext && next !== null) {
      next.render(this.outB, frames, params);
    } else {
      for (let c = 0; c < this.channels; c += 1)
        this.outB[c]?.fill(0, 0, frames);
    }

    // 2) ALC alignment
    const latA = active?.totalLatencyFrames ?? 0;
    const latB = next?.totalLatencyFrames ?? 0;

    const padA = Math.max(0, this.laneDelayFrames - latA);
    const padB = Math.max(0, this.laneDelayFrames - latB);

    for (let c = 0; c < this.channels; c += 1) {
      this.delayA[c]!.process(this.outA[c]!, this.alignedA[c]!, frames, padA);
      this.delayB[c]!.process(this.outB[c]!, this.alignedB[c]!, frames, padB);
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

        for (let i = 0; i < frames; i += 1) {
          const t = clamp01((done0 + i) / total);
          dst[i] = (1 - t) * aBuf[i]! + t * bBuf[i]!;
        }
      }

      this.pushOutput(this.mixOut, frames);
      return;
    }

    // Prewarm: output active only
    if (decision.kind === "runCurrentAndPrewarmNext") {
      this.pushOutput(this.alignedA, frames);
      return;
    }

    // Normal / retire boundary: output active only
    this.pushOutput(this.alignedA, frames);
  }
}
