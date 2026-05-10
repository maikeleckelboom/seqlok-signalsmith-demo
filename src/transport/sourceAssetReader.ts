import type { RuntimePcmAsset } from "./pcmAssetTypes";

export interface SourceAssetReader {
  readonly asset: RuntimePcmAsset | null;

  /**
   * Read `frames` samples starting at `sourceFrameCursor` into `dstPerChannel`.
   * Zero-pads if reading past the end of the asset.
   * Returns the number of actual frames read (may be less than `frames` near EOF).
   */
  readSegment(
    dstPerChannel: Float32Array[],
    sourceFrameCursor: number,
    frames: number,
  ): number;
}

export function createSourceAssetReader(
  asset: RuntimePcmAsset | null,
): SourceAssetReader {
  function readSegment(
    dstPerChannel: Float32Array[],
    sourceFrameCursor: number,
    frames: number,
  ): number {
    if (asset === null || frames <= 0) {
      for (const dst of dstPerChannel) {
        if (dst !== undefined) {
          dst.fill(0, 0, Math.min(frames, dst.length));
        }
      }
      return 0;
    }

    const start = Math.max(0, sourceFrameCursor);
    const end = Math.min(asset.totalFrames, start + frames);
    const actualFrames = Math.max(0, end - start);

    const channelsToUse = Math.min(asset.channelCount, dstPerChannel.length);

    for (let c = 0; c < channelsToUse; c += 1) {
      const dst = dstPerChannel[c];
      const src = asset.channels[c];

      if (dst === undefined || src === undefined) {
        continue;
      }

      const limit = Math.min(frames, dst.length);

      if (actualFrames > 0 && start < asset.totalFrames) {
        dst.set(src.subarray(start, start + actualFrames), 0);
      }

      if (actualFrames < limit) {
        dst.fill(0, actualFrames, limit);
      }
    }

    // Zero remaining dst channels if asset has fewer channels
    for (let c = channelsToUse; c < dstPerChannel.length; c += 1) {
      const dst = dstPerChannel[c];
      if (dst !== undefined) {
        dst.fill(0, 0, Math.min(frames, dst.length));
      }
    }

    return actualFrames;
  }

  return {
    get asset() {
      return asset;
    },
    readSegment,
  };
}
