import type {
  StretchParams,
  StretchStructuralConfig,
} from "../engine/stretch-config";
import type { LoadedPcmAsset } from "../transport/pcm-asset-types";

type ControlMessage =
  | { type: "init"; mailboxId: string; structural: StretchStructuralConfig; initialParams: StretchParams }
  | { type: "loadAsset"; asset: LoadedPcmAsset }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seekToFrame"; frame: number }
  | { type: "updateParams"; params: StretchParams }
  | { type: "scheduleSwap"; nextStructural: StretchStructuralConfig; fadeFrames: number; prewarmLeadInFrames: number };

export class StretchLaneNode extends AudioWorkletNode {
  constructor(context: AudioContext, init: {
    readonly structural: StretchStructuralConfig;
    readonly initialParams: StretchParams;
    readonly mailboxId: string;
  }) {
    const { structural } = init;

    super(context, "stretch-lane-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      channelCount: structural.channels,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });

    const msg: ControlMessage = {
      type: "init",
      mailboxId: init.mailboxId,
      structural: {
        ...structural,
        sampleRate: context.sampleRate,
      },
      initialParams: init.initialParams,
    };

    this.port.postMessage(msg);
  }

  loadAsset(asset: LoadedPcmAsset): void {
    const msg: ControlMessage = { type: "loadAsset", asset };
    this.port.postMessage(msg);
  }

  play(): void {
    const msg: ControlMessage = { type: "play" };
    this.port.postMessage(msg);
  }

  pause(): void {
    const msg: ControlMessage = { type: "pause" };
    this.port.postMessage(msg);
  }

  seekToFrame(frame: number): void {
    const msg: ControlMessage = { type: "seekToFrame", frame };
    this.port.postMessage(msg);
  }

  updateParams(params: StretchParams): void {
    const msg: ControlMessage = { type: "updateParams", params };
    this.port.postMessage(msg);
  }

  scheduleSwap(
    nextStructural: StretchStructuralConfig,
    fadeFrames: number,
    prewarmLeadInFrames: number,
  ): void {
    const msg: ControlMessage = {
      type: "scheduleSwap",
      nextStructural,
      fadeFrames,
      prewarmLeadInFrames,
    };
    this.port.postMessage(msg);
  }
}
