/**
 * A single frame of audio analysis passed to visualizations each animation tick.
 * All values are normalized 0..1 unless marked otherwise.
 */
export interface AudioFrame {
  /** Raw FFT magnitudes (0..255 per bin, typical fftSize=2048 → 1024 bins). */
  fft: Uint8Array;
  /** Time-domain waveform (0..255, centered at 128). */
  waveform: Uint8Array;
  /** Sample rate of the underlying context. Lets visualizations map bin → Hz. */
  sampleRate: number;

  /** Energy band averages, normalized 0..1. */
  bass: number;
  mid: number;
  treble: number;
  /** Overall energy, normalized 0..1. */
  energy: number;

  /** True on the tick a beat is detected. Single-frame pulse. */
  beat: boolean;
  /** Estimated BPM; 0 when unknown. */
  bpm: number;

  /** Total elapsed seconds since AudioEngine started emitting frames. */
  t: number;
  /** Seconds since the previous frame. */
  dt: number;
}

/** A listener function that receives every emitted AudioFrame. */
export type AudioFrameListener = (frame: AudioFrame) => void;
