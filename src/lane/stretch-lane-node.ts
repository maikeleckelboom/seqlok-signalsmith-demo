import type {
  StretchParams,
  StretchStructuralConfig,
} from "../engine/stretch-config";

interface StretchLaneNodeInit {
  readonly structural: StretchStructuralConfig;
  readonly initialParams: StretchParams;
  readonly mailboxId: string;
}

interface InitControlMessage {
  readonly type: "init";
  readonly mailboxId: string;
  readonly structural: StretchStructuralConfig;
  readonly initialParams: StretchParams;
}

interface UpdateParamsControlMessage {
  readonly type: "updateParams";
  readonly params: StretchParams;
}

interface ScheduleSwapControlMessage {
  readonly type: "scheduleSwap";
  readonly nextStructural: StretchStructuralConfig;
  readonly fadeFrames: number;
  readonly prewarmLeadInFrames: number;
}

type ControlMessage =
  | InitControlMessage
  | UpdateParamsControlMessage
  | ScheduleSwapControlMessage;

export class StretchLaneNode extends AudioWorkletNode {
  constructor(context: AudioContext, init: StretchLaneNodeInit) {
    const { structural } = init;

    super(context, "stretch-lane-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: structural.channels,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });

    const msg: InitControlMessage = {
      type: "init",
      mailboxId: init.mailboxId,
      structural: {
        ...structural,
        sampleRate: context.sampleRate,
      },
      initialParams: init.initialParams,
    };

    this.port.postMessage(msg as ControlMessage);
  }

  updateParams(params: StretchParams): void {
    const msg: UpdateParamsControlMessage = {
      type: "updateParams",
      params,
    };
    this.port.postMessage(msg as ControlMessage);
  }

  scheduleSwap(
    nextStructural: StretchStructuralConfig,
    fadeFrames: number,
    prewarmLeadInFrames: number,
  ): void {
    const msg: ScheduleSwapControlMessage = {
      type: "scheduleSwap",
      nextStructural,
      fadeFrames,
      prewarmLeadInFrames,
    };
    this.port.postMessage(msg as ControlMessage);
  }
}
