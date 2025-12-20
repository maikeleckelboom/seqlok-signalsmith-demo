export interface StretchStructuralConfig {
  readonly channels: number;
  readonly sampleRate: number;
  readonly blockSamples: number;
  readonly intervalSamples: number;
  readonly splitComputation: boolean;
  readonly preset: "default" | "cheaper";
}

export interface StretchParams {
  readonly speedFactor: number; // playback rate
  readonly pitchSemitones: number; // -12..+12 etc.
  readonly formantSemitones: number; // -12..+12
  readonly tonalityLimit: number; // 0..0.5 (fraction of Nyquist)
  readonly formantCompensate: boolean;
  readonly formantBaseHz: number; // usually around 200–300 Hz
}
