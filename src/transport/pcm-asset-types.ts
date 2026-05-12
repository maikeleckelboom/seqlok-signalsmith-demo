export type PcmAssetId = string;

export interface LoadedPcmAsset {
  id: PcmAssetId;
  channelCount: number;
  sampleRate: number;
  totalFrames: number;
  channelDataSab: SharedArrayBuffer[];
}

export interface RuntimePcmAsset {
  id: PcmAssetId;
  channelCount: number;
  sampleRate: number;
  totalFrames: number;
  channels: Float32Array[];
}
