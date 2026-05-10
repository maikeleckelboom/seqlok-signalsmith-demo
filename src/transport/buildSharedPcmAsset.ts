import type { LoadedPcmAsset, PcmAssetId } from "./pcmAssetTypes";

let idCounter = 0;

export function buildSharedPcmAsset(
  audioBuffer: AudioBuffer,
  id?: PcmAssetId,
): LoadedPcmAsset {
  const channelCount = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const totalFrames = audioBuffer.length;

  const channelDataSab: SharedArrayBuffer[] = [];

  for (let c = 0; c < channelCount; c += 1) {
    const src = audioBuffer.getChannelData(c);
    const sab = new SharedArrayBuffer(src.length * 4);
    const dst = new Float32Array(sab);
    dst.set(src);
    channelDataSab.push(sab);
  }

  return {
    id: id ?? `asset-${++idCounter}`,
    channelCount,
    sampleRate,
    totalFrames,
    channelDataSab,
  };
}
