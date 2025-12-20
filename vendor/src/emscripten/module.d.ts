/**
 * # Signalsmith Stretch — Emscripten WASM Bridge
 *
 * TypeScript contract for the Signalsmith Stretch audio time-stretching and pitch-shifting library.
 *
 * This module provides real-time, high-quality audio time-stretching and pitch-shifting
 * using phase vocoder techniques with proprietary enhancements for transient preservation
 * and spectral coherence.
 *
 * @module signalsmith-stretch
 * @see {@link https://signalsmith-audio.co.uk/code/stretch/#how-to-use-time-stretching}
 * @see {@link https://signalsmith-audio.co.uk/writing/2023/stretch-design/}
 */

/**
 * ## Source of Truth
 *
 * This declaration mirrors the **exact C ABI** exported by `main.cpp` (compiled via Emscripten),
 * which wraps `signalsmith::stretch::SignalsmithStretch<float>` from `signalsmith-stretch.h`.
 *
 * Function names and parameters correspond **1:1** with the `extern "C"` exports.
 * At runtime, they are available as `Module._<name>`.
 */

/**
 * ## Units & Conventions
 *
 * ### Samples
 * - **Type**: Integer counts
 * - **Usage**: Latencies, block sizes, intervals/hops
 * - **Note**: Time configuration uses samples, not milliseconds
 *   (preset helpers handle ms→samples conversion internally)
 *
 * ### Frequencies
 * - **`tonalityLimit`**: Normalized frequency (0.0–0.5)
 *   - Multiple of sample rate
 *   - 0.5 ≈ Nyquist frequency
 * - **`setFormantBase(hz)`**: Absolute frequency in Hz
 *   - 0 = automatic detection
 *
 * ### Booleans
 * - **Type**: C-style booleans across the WASM bridge
 * - **Values**: Use `0 | 1` from JavaScript/TypeScript
 */

/**
 * ## I/O Memory Layout (Planar Window)
 *
 * The `_setBuffers(ch, len)` function allocates a single contiguous float region
 * of size `len × ch × 2`, organized as input planes followed by output planes:
 *
 * ```
 * Memory Layout:
 * ┌──────────────────────────┬──────────────────────────┐
 * │      INPUT PLANES        │      OUTPUT PLANES       │
 * │     (len × ch floats)    │     (len × ch floats)    │
 * └──────────────────────────┴──────────────────────────┘
 * ↑ base pointer                                         → byte offsets
 *
 * Channel Offsets:
 * IN[c] = base + (c × len × 4) // Input channel c
 * OUT[c] = base + ((c + ch) × len × 4) // Output channel c
 * ```
 *
 * ### Typical View Construction
 * ```TypeScript
 * const base = mod._setBuffers(channels, length);
 *
 * // Create typed array views for each channel
 * const inputViews = [], outputViews = [];
 * for (let c = 0; c < channels; c++) {
 *   inputViews[c] = new Float32Array(mod.HEAPF32.buffer,
 *                                      base + c * length * 4,
 *                                      length);
 *   outputViews[c] = new Float32Array(mod.HEAPF32.buffer,
 *                                      base + (c + channels) * length * 4,
 *                                      length);
 * }
 * ```
 */

/**
 * ## Render Loop (Host-Managed / Constant-Seek)
 *
 * ### Processing Pipeline
 * 1. **Fill Input**: Host writes audio to input planes for current quantum
 * 2. **Update State**: Host sets transport/config (seek/rate/pitch/formant)
 * 3. **Process**: Host calls `_process(inputSamples, outputSamples)`
 * 4. **Read Output**: Host reads output planes and mixes to audio outputs
 *
 * ### Position Management
 * Use `_seek(inputSamples, playbackRate)` to advance the internal input position
 * with an implied rate segment before the next `_process` call.
 */

/** Pointer type representing a memory address in the WASM heap */
export type Ptr = number;

/** C-style boolean for WASM bridge (0 = false, 1 = true) */
export type CBool = 0 | 1;

/**
 * Signalsmith Stretch WASM module interface.
 * Provides low-level access to the C++ stretch algorithm via Emscripten bindings.
 */
export interface SignalsmithStretchModule {
  /**
   * Emscripten float heap view.
   * Use `.buffer` with byte offsets to create `Float32Array` views for audio I/O.
   * @readonly
   */
  readonly HEAPF32: Float32Array;

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //  Raw C Exports (accessible as Module._name)
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Allocates planar I/O windows for audio processing.
   *
   * Creates a contiguous memory region for input and output audio buffers,
   * organized as separate planes for each channel.
   *
   * @param channels - Number of audio channels
   * @param length - Samples per plane (buffer size)
   * @returns Byte offset (pointer) into `HEAPF32.buffer` marking start of IN[0]
   */
  _setBuffers(channels: number, length: number): Ptr;

  /**
   * Gets the analysis/synthesis block size.
   *
   * @returns Window size in samples (post-configuration or preset)
   */
  _blockSamples(): number;

  /**
   * Gets the effective hop/interval size.
   *
   * @returns Hop size in samples (post-configuration or preset)
   */
  _intervalSamples(): number;

  /**
   * Gets the algorithmic input latency.
   *
   * @returns Input delay in samples
   */
  _inputLatency(): number;

  /**
   * Gets the algorithmic output latency.
   *
   * @returns Output delay in samples
   */
  _outputLatency(): number;

  /**
   * Resets all internal states while preserving configuration.
   *
   * Clears audio buffers and processing history but maintains
   * current settings for block size, interval, pitch, etc.
   */
  _reset(): void;

  /**
   * Applies the default quality/cost preset configuration.
   *
   * Automatically derives optimal block and interval sizes based on
   * channel count and sample rate for balanced quality and performance.
   *
   * @param nChannels - Number of audio channels
   * @param sampleRate - Sample rate in Hz
   */
  _presetDefault(nChannels: number, sampleRate: number): void;

  /**
   * Applies a lower-CPU preset configuration.
   *
   * Optimizes for reduced computational cost with acceptable quality,
   * suitable for real-time processing on constrained systems.
   *
   * @param nChannels - Number of audio channels
   * @param sampleRate - Sample rate in Hz
   */
  _presetCheaper(nChannels: number, sampleRate: number): void;

  /**
   * Manually configures processing parameters.
   *
   * Allows fine control over the phase vocoder configuration for
   * custom quality/latency/CPU trade-offs.
   *
   * @param nChannels - Number of audio channels
   * @param blockSamples - Analysis/synthesis window size in samples
   * @param intervalSamples - Hop/interval size in samples
   * @param splitComputation - Enable split computation across frames (0=off, 1=on)
   */
  _configure(
    nChannels: number,
    blockSamples: number,
    intervalSamples: number,
    splitComputation: CBool,
  ): void;

  /**
   * Sets pitch transposition by multiplicative factor.
   *
   * @param multiplier - Pitch shift factor (1.0 = no change, 2.0 = octave up)
   * @param tonalityLimit - Frequency limit as a fraction of sample rate (0.0–0.5)
   *                        Controls preservation of tonal characteristics
   */
  _setTransposeFactor(multiplier: number, tonalityLimit: number): void;

  /**
   * Sets pitch transposition in semitones.
   *
   * @param semitones - Pitch shift in semitones (+12 = octave up, -12 = octave down)
   * @param tonalityLimit - Frequency limit as fraction of sample rate (0.0–0.5)
   *                        Controls preservation of tonal characteristics
   */
  _setTransposeSemitones(semitones: number, tonalityLimit: number): void;

  /**
   * Sets formant shift by multiplicative factor.
   *
   * Shifts spectral envelope without changing pitch, useful for
   * voice character modification.
   *
   * @param factor - Formant shift factor (1.0 = no change)
   * @param compensate - Apply amplitude compensation (0=off, 1=on)
   */
  _setFormantFactor(factor: number, compensate: CBool): void;

  /**
   * Sets formant shift in semitones.
   *
   * Shifts spectral envelope without changing pitch, useful for
   * voice character modification.
   *
   * @param semitones - Formant shift in semitones
   * @param compensate - Apply amplitude compensation (0=off, 1=on)
   */
  _setFormantSemitones(semitones: number, compensate: CBool): void;

  /**
   * Sets the formant analysis base frequency.
   *
   * @param hz - Base frequency in Hz (0 = automatic detection)
   */
  _setFormantBase(hz: number): void;

  /**
   * Provides pre-roll input and advances the internal position.
   *
   * Used to maintain continuity when jumping to new positions or
   * changing playback rate without processing output.
   *
   * @param inputSamples - Number of input samples provided
   * @param playbackRate - Implied playback rate for this segment
   */
  _seek(inputSamples: number, playbackRate: number): void;

  /**
   * Processes one audio quantum.
   *
   * Consumes input samples and produces time-stretched/pitch-shifted output
   * according to the current configuration.
   *
   * @param inputSamples - Number of input samples to consume
   * @param outputSamples - Number of output samples to synthesize
   */
  _process(inputSamples: number, outputSamples: number): void;

  /**
   * Flushes pending output and processing tails.
   *
   * Used to extract remaining audio after input has ended.
   *
   * @param outputSamples - Number of output samples to flush
   */
  _flush(outputSamples: number): void;
}

/**
 * Emscripten module factory function.
 *
 * Creates and initializes the WASM module asynchronously.
 *
 * @param opts - Configuration options
 * @param opts.locateFile - Custom function to resolve the `.wasm` file URL
 * @param opts.wasmBinary - Pre-loaded WASM binary (optional)
 * @returns Promise resolving to the initialized module
 *
 * @example
 * ```TypeScript
 * const module = await createModule({
 *   locateFile: (path) => `/wasm/${path}`
 * });
 * ```
 */
export type CreateModule = (opts?: {
  locateFile?: (path: string) => string;
  wasmBinary?: ArrayBuffer;
}) => Promise<SignalsmithStretchModule>;

declare const createModule: CreateModule;
export default createModule;
