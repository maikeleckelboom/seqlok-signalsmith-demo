import { describe, expect, it } from "vitest";
import { createSourceAssetReader } from "../sourceAssetReader";

describe("sourceAssetReader", () => {
  function makeAsset(totalFrames: number, channelCount = 2) {
    const channels: Float32Array[] = [];
    for (let c = 0; c < channelCount; c++) {
      const arr = new Float32Array(totalFrames);
      for (let i = 0; i < totalFrames; i++) {
        arr[i] = (c + 1) * 0.1 + i * 0.0001;
      }
      channels.push(arr);
    }
    return {
      id: "a",
      channelCount,
      sampleRate: 48000,
      totalFrames,
      channels,
    };
  }

  it("reads a normal segment in the middle of the asset", () => {
    const asset = makeAsset(1000);
    const reader = createSourceAssetReader(asset);

    const dst = [new Float32Array(100), new Float32Array(100)];
    const actual = reader.readSegment(dst, 100, 100);

    expect(actual).toBe(100);
    expect(dst[0]![0]).toBe(asset.channels[0]![100]);
    expect(dst[1]![0]).toBe(asset.channels[1]![100]);
    expect(dst[0]![99]).toBe(asset.channels[0]![199]);
  });

  it("zero-pads when reading past EOF", () => {
    const asset = makeAsset(200);
    const reader = createSourceAssetReader(asset);

    const dst = [new Float32Array(100), new Float32Array(100)];
    const actual = reader.readSegment(dst, 150, 100);

    expect(actual).toBe(50);
    expect(dst[0]![0]).toBe(asset.channels[0]![150]);
    expect(dst[0]![49]).toBe(asset.channels[0]![199]);
    expect(dst[0]![50]).toBe(0);
    expect(dst[0]![99]).toBe(0);
  });

  it("zero-pads entirely when starting at EOF", () => {
    const asset = makeAsset(200);
    const reader = createSourceAssetReader(asset);

    const dst = [new Float32Array(50), new Float32Array(50)];
    const actual = reader.readSegment(dst, 200, 50);

    expect(actual).toBe(0);
    expect(dst[0]!.every((v) => v === 0)).toBe(true);
  });

  it("zero-pads near start when sourceFrameCursor is negative", () => {
    const asset = makeAsset(200);
    const reader = createSourceAssetReader(asset);

    const dst = [new Float32Array(50), new Float32Array(50)];
    const actual = reader.readSegment(dst, -10, 50);

    expect(actual).toBe(50);
    expect(dst[0]![0]).toBe(asset.channels[0]![0]);
    expect(dst[0]![49]).toBe(asset.channels[0]![49]);
  });

  it("handles null asset", () => {
    const reader = createSourceAssetReader(null);
    const dst = [new Float32Array(50), new Float32Array(50)];
    const actual = reader.readSegment(dst, 0, 50);

    expect(actual).toBe(0);
    expect(dst[0]!.every((v) => v === 0)).toBe(true);
  });

  it("handles fewer dst channels than asset channels", () => {
    const asset = makeAsset(100, 4);
    const reader = createSourceAssetReader(asset);

    const dst = [new Float32Array(10)];
    const actual = reader.readSegment(dst, 0, 10);

    expect(actual).toBe(10);
    expect(dst[0]![0]).toBe(asset.channels[0]![0]);
  });

  it("zero-pads extra dst channels when asset has fewer channels", () => {
    const asset = makeAsset(100, 1);
    const reader = createSourceAssetReader(asset);

    const dst = [new Float32Array(10), new Float32Array(10)];
    const actual = reader.readSegment(dst, 0, 10);

    expect(actual).toBe(10);
    expect(dst[0]![0]).toBe(asset.channels[0]![0]);
    expect(dst[1]!.every((v) => v === 0)).toBe(true);
  });
});
