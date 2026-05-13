/**
 * TypeScript declarations for the Emscripten bridge around Signalsmith Stretch.
 * Mirrors the C ABI exported by `main.cpp`.
 */

export type Ptr = number;
export type CBool = 0 | 1;

export interface SignalsmithStretchModule {
    /** Emscripten float heap used for planar input/output views. */
    readonly HEAPF32: Float32Array;

    /**
     * Allocates contiguous planar I/O memory.
     * Layout: input planes first, then output planes.
     * Returns the byte offset of input channel 0.
     */
    _setBuffers(channels: number, length: number): Ptr;

    _blockSamples(): number;

    _intervalSamples(): number;

    _inputLatency(): number;

    _outputLatency(): number;

    _reset(): void;

    _presetDefault(nChannels: number, sampleRate: number): void;

    _presetCheaper(nChannels: number, sampleRate: number): void;

    /**
     * `blockSamples` and `intervalSamples` are sample counts.
     * `splitComputation` uses `0 | 1` across the ABI.
     */
    _configure(nChannels: number, blockSamples: number, intervalSamples: number, splitComputation: CBool,): void;

    /** `tonalityLimit` is normalized frequency in the range `0.0..0.5`. */
    _setTransposeFactor(multiplier: number, tonalityLimit: number): void;

    /** `tonalityLimit` is normalized frequency in the range `0.0..0.5`. */
    _setTransposeSemitones(semitones: number, tonalityLimit: number): void;

    _setFormantFactor(factor: number, compensate: CBool): void;

    _setFormantSemitones(semitones: number, compensate: CBool): void;

    /** `0` means automatic detection. */
    _setFormantBase(hz: number): void;

    _seek(inputSamples: number, playbackRate: number): void;

    _process(inputSamples: number, outputSamples: number): void;

    _flush(outputSamples: number): void;
}

export type CreateModule = (opts?: {
    locateFile?: (path: string) => string;
    wasmBinary?: ArrayBuffer;
}) => Promise<SignalsmithStretchModule>;

declare const createModule: CreateModule;
export default createModule;
