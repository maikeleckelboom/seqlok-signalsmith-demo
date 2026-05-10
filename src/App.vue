<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { StretchLaneNode } from "./lane/stretchLaneNode.ts";
import stretchWorkletUrl from "./worklet/stretchLaneProcessor.ts?url";
import type {
  StretchParams,
  StretchStructuralConfig,
} from "./engine/stretchConfig";
import { buildSharedPcmAsset } from "./transport/buildSharedPcmAsset.ts";

// ----------------------
// Static config
// ----------------------

const structuralBase: StretchStructuralConfig = {
  channels: 2,
  sampleRate: 48_000,
  blockSamples: 4096,
  intervalSamples: 1024,
  splitComputation: false,
  preset: "default",
};

const baseParams: StretchParams = {
  speedFactor: 1,
  pitchSemitones: 0,
  formantSemitones: 0,
  tonalityLimit: 0.45,
  formantCompensate: true,
  formantBaseHz: 240,
};

// ----------------------
// Audio + worklet state
// ----------------------

let audioContext: AudioContext | null = null;
let stretchNode: StretchLaneNode | null = null;
let workletLoadedForContext: AudioContext | null = null;

// Reactive UI flags
const isContextReady = ref(false);
const isWorkletReady = ref(false);
const isNodeReady = ref(false);
const isPlaying = ref(false);
const hasFile = ref(false);

// File info
const fileName = ref<string | null>(null);
const fileDuration = ref(0);
const fileSampleRate = ref(0);
const fileTotalFrames = ref(0);

// User controls
const speedFactor = ref(baseParams.speedFactor); // time-stretch ratio
const pitchSemitones = ref(baseParams.pitchSemitones);
const seekPosition = ref(0); // 0..1 across the whole track
const currentPreset = ref<"default" | "cheaper">(structuralBase.preset);

// Telemetry from worklet
const timelineFrame = ref(0);
const slotPhase = ref<string>("idle");
const mixProgress = ref(0);
const lastBlockRms = ref(0);

// Derived value
const timelineSeconds = computed(() => {
  const ctx = audioContext;
  if (!ctx) {
    return 0;
  }
  return timelineFrame.value / ctx.sampleRate;
});

// ----------------------
// Param helpers
// ----------------------

function buildParams(): StretchParams {
  return {
    ...baseParams,
    speedFactor: speedFactor.value,
    pitchSemitones: pitchSemitones.value,
  };
}

function pushParamsToNode(): void {
  const node = stretchNode;
  if (!node) {
    return;
  }
  node.updateParams(buildParams());
}

// Keep worklet params in sync with UI controls
watch([speedFactor, pitchSemitones], () => {
  pushParamsToNode();
});

// ----------------------
// Audio / worklet wiring
// ----------------------

async function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (workletLoadedForContext === ctx) {
    return;
  }
  await ctx.audioWorklet.addModule(stretchWorkletUrl);
  workletLoadedForContext = ctx;
  isWorkletReady.value = true;
}

async function ensureContext(): Promise<AudioContext> {
  if (audioContext !== null) {
    return audioContext;
  }
  const ctx = new AudioContext();
  audioContext = ctx;
  isContextReady.value = true;
  await ensureWorklet(ctx);
  return ctx;
}

function attachTelemetry(node: StretchLaneNode): void {
  interface TelemetryMessage {
    readonly type: "telemetry";
    readonly timelineFrame: number;
    readonly slotPhase: string;
    readonly mixTo: number;
    readonly blockRms: number;
  }

  node.port.onmessage = (event: MessageEvent<TelemetryMessage>): void => {
    const msg = event.data;
    if (msg.type !== "telemetry") {
      return;
    }
    timelineFrame.value = msg.timelineFrame;
    slotPhase.value = msg.slotPhase;
    mixProgress.value = Math.min(1, Math.max(0, msg.mixTo));
    lastBlockRms.value = msg.blockRms;
  };
}

async function ensureNode(): Promise<StretchLaneNode> {
  const ctx = await ensureContext();
  if (stretchNode !== null) {
    return stretchNode;
  }

  const node = new StretchLaneNode(ctx, {
    structural: {
      ...structuralBase,
      sampleRate: ctx.sampleRate,
    },
    initialParams: buildParams(),
    mailboxId: "stretch-lane-0",
  });

  attachTelemetry(node);
  node.connect(ctx.destination);

  stretchNode = node;
  isNodeReady.value = true;

  return node;
}

// ----------------------
// File loading + playback
// ----------------------

async function handleFileChange(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement | null;
  const file = target?.files?.[0];
  if (!file) {
    return;
  }

  const ctx = await ensureContext();
  const arrayBuffer = await file.arrayBuffer();
  const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);

  const asset = buildSharedPcmAsset(decodedBuffer);

  const node = await ensureNode();
  node.loadAsset(asset);
  pushParamsToNode();

  hasFile.value = true;
  fileName.value = file.name;
  fileDuration.value = decodedBuffer.duration;
  fileSampleRate.value = decodedBuffer.sampleRate;
  fileTotalFrames.value = decodedBuffer.length;
  seekPosition.value = 0;
}

async function play(): Promise<void> {
  if (!hasFile.value) {
    return;
  }

  const ctx = await ensureContext();
  await ctx.resume();
  const node = await ensureNode();
  pushParamsToNode();

  node.play();
  isPlaying.value = true;
}

function pause(): void {
  stretchNode?.pause();
  isPlaying.value = false;
}

// Seek slider -> explicit seekToFrame command
function applySeek(): void {
  if (!hasFile.value || fileTotalFrames.value <= 0) {
    return;
  }

  const clamped = Math.min(1, Math.max(0, seekPosition.value));
  const targetFrame = Math.floor(clamped * fileTotalFrames.value);

  stretchNode?.seekToFrame(targetFrame);
}

// ----------------------
// Hotswap control
// ----------------------

async function triggerSwap(): Promise<void> {
  const node = stretchNode;
  const ctx = audioContext;

  if (!node || !ctx) {
    return;
  }

  const nextPreset: "default" | "cheaper" =
    currentPreset.value === "default" ? "cheaper" : "default";

  const fadeFrames = ctx.sampleRate; // ~1 second
  const prewarmLeadInFrames = structuralBase.blockSamples * 8;

  node.scheduleSwap(
    {
      ...structuralBase,
      sampleRate: ctx.sampleRate,
      preset: nextPreset,
    },
    fadeFrames,
    prewarmLeadInFrames,
  );

  currentPreset.value = nextPreset;
}

// ----------------------
// Cleanup
// ----------------------

onBeforeUnmount(() => {
  pause();

  if (stretchNode !== null) {
    stretchNode.disconnect();
    stretchNode = null;
  }

  if (audioContext !== null) {
    void audioContext.close();
    audioContext = null;
  }
});
</script>

<template>
  <main
    class="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center gap-8"
  >
    <section class="space-y-4 w-full max-w-xl">
      <h1 class="text-2xl font-semibold tracking-tight">
        Seqlok × Signalsmith stretch lane
      </h1>

      <p class="text-sm text-slate-400">
        This is running the real Signalsmith stretch WASM through a Seqlok
        hotswap lane inside an <code>AudioWorkletProcessor</code>. Transport,
        seek, and time-stretch are owned by the worklet runtime via a
        SAB-backed planar PCM asset.
      </p>

      <!-- File input -->
      <div class="flex flex-wrap items-center gap-3">
        <label
          class="px-4 py-2 rounded-lg bg-slate-700 text-sm font-medium cursor-pointer"
        >
          <span>Select audio file</span>
          <input
            type="file"
            accept="audio/*"
            class="hidden"
            @change="handleFileChange"
          />
        </label>

        <div v-if="hasFile" class="text-xs text-slate-300">
          <div class="truncate max-w-xs">
            <span class="text-slate-500">File:</span> {{ fileName }}
          </div>
          <div>
            <span class="text-slate-500">Duration:</span>
            {{ fileDuration.toFixed(2) }} s
          </div>
        </div>
      </div>

      <!-- Transport + hotswap controls -->
      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="px-4 py-2 rounded-lg bg-emerald-500/90 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!hasFile || isPlaying"
          @click="play"
        >
          Play via stretch lane
        </button>

        <button
          type="button"
          class="px-4 py-2 rounded-lg bg-slate-700 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!isPlaying"
          @click="pause"
        >
          Pause
        </button>

        <button
          type="button"
          class="px-4 py-2 rounded-lg bg-sky-500/90 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!isNodeReady"
          @click="triggerSwap"
        >
          Schedule structural swap
          <span class="ml-1 text-xs uppercase tracking-wide">
            (preset: {{ currentPreset }})
          </span>
        </button>
      </div>

      <!-- Seek -->
      <div class="flex items-center gap-3">
        <label class="text-xs text-slate-300 flex items-center gap-2">
          Seek
          <input
            v-model.number="seekPosition"
            type="range"
            min="0"
            max="1"
            step="0.001"
            class="w-40 accent-sky-400"
            :disabled="!hasFile"
            @change="applySeek"
          />
          <span class="tabular-nums">
            {{ (seekPosition * fileDuration).toFixed(1) }}s /
            {{ fileDuration.toFixed(1) }}s
          </span>
        </label>
      </div>

      <!-- Time-stretch + pitch controls -->
      <div class="space-y-2">
        <div class="flex items-center gap-3">
          <label class="text-xs text-slate-300 flex items-center gap-2">
            Time-stretch
            <input
              v-model.number="speedFactor"
              type="range"
              min="0.5"
              max="2"
              step="0.01"
              class="w-40 accent-emerald-400"
            />
            <span class="tabular-ums"> {{ speedFactor.toFixed(2) }}× </span>
          </label>
        </div>

        <div class="flex items-center gap-3">
          <label class="text-xs text-slate-300 flex items-center gap-2">
            Pitch
            <input
              v-model.number="pitchSemitones"
              type="range"
              min="-12"
              max="12"
              step="0.1"
              class="w-40 accent-violet-400"
            />
            <span class="tabular-nums">
              {{ pitchSemitones.toFixed(1) }} st
            </span>
          </label>
        </div>
      </div>

      <!-- Status -->
      <div class="flex flex-wrap gap-4 text-[11px] text-slate-400">
        <span>ctx: {{ isContextReady ? "ready" : "not ready" }}</span>
        <span>worklet: {{ isWorkletReady ? "loaded" : "not loaded" }}</span>
        <span>node: {{ isNodeReady ? "ready" : "not ready" }}</span>
        <span>playing: {{ isPlaying ? "yes" : "no" }}</span>
      </div>
    </section>

    <!-- Telemetry -->
    <section
      class="w-full max-w-xl rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-xs font-mono"
    >
      <div class="flex justify-between mb-1">
        <span class="text-slate-400">timeline frame</span>
        <span>{{ timelineFrame }}</span>
      </div>
      <div class="flex justify-between mb-1">
        <span class="text-slate-400">timeline time</span>
        <span>{{ timelineSeconds.toFixed(3) }} s</span>
      </div>
      <div class="flex justify-between mb-1">
        <span class="text-slate-400">slot phase</span>
        <span>{{ slotPhase }}</span>
      </div>
      <div class="flex justify-between mb-1">
        <span class="text-slate-400">mix progress</span>
        <span>{{ (mixProgress * 100).toFixed(2) }}%</span>
      </div>
      <div class="flex justify-between">
        <span class="text-slate-400">last block RMS</span>
        <span>{{ lastBlockRms.toFixed(5) }}</span>
      </div>
    </section>
  </main>
</template>
