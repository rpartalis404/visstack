/**
 * Lightweight energy-based beat detector.
 *
 * Maintains a rolling history of recent bass energy. A beat is emitted when
 * the current bass energy spikes above (mean + k * stddev) of that history,
 * with a minimum inter-beat interval to prevent double-triggers.
 *
 * Also produces a rough BPM estimate by averaging the intervals between
 * recent beats (ignoring outliers).
 *
 * This is deliberately simpler than `web-audio-beat-detector` (which does
 * offline analysis of a whole buffer). For real-time streaming we need an
 * online detector — this handles that and is ~50 lines instead of a dep.
 */

export interface BeatDetectorOptions {
  /** How many recent samples to average for the threshold. */
  historySize?: number;
  /** Threshold multiplier on the stddev. Higher = more selective. */
  sensitivity?: number;
  /** Minimum gap between detected beats, in ms. Prevents double-triggers. */
  minIntervalMs?: number;
}

interface BeatResult {
  beat: boolean;
  bpm: number;
}

export class BeatDetector {
  private readonly historySize: number;
  private readonly sensitivity: number;
  private readonly minIntervalMs: number;

  private history: number[] = [];
  private recentBeatTimes: number[] = [];
  private lastBeatMs = 0;

  constructor(opts: BeatDetectorOptions = {}) {
    this.historySize = opts.historySize ?? 43; // ~0.7s at 60fps
    this.sensitivity = opts.sensitivity ?? 1.35;
    this.minIntervalMs = opts.minIntervalMs ?? 250; // cap at 240 BPM
  }

  /** Feed one bass-energy sample (0..1). Returns beat + running BPM. */
  update(bassEnergy: number, nowMs: number): BeatResult {
    this.history.push(bassEnergy);
    if (this.history.length > this.historySize) this.history.shift();

    // Need some warm-up before we trust the stats
    if (this.history.length < 12) return { beat: false, bpm: this.bpm() };

    const mean = this.history.reduce((a, b) => a + b, 0) / this.history.length;
    const variance =
      this.history.reduce((s, v) => s + (v - mean) ** 2, 0) / this.history.length;
    const std = Math.sqrt(variance);
    const threshold = mean + this.sensitivity * std;

    const sinceLast = nowMs - this.lastBeatMs;
    const isBeat =
      bassEnergy > threshold &&
      bassEnergy > 0.15 && // floor to ignore quiet passages
      sinceLast > this.minIntervalMs;

    if (isBeat) {
      this.recentBeatTimes.push(nowMs);
      if (this.recentBeatTimes.length > 16) this.recentBeatTimes.shift();
      this.lastBeatMs = nowMs;
    }

    return { beat: isBeat, bpm: this.bpm() };
  }

  /** Rough BPM from recent beat intervals. 0 if not enough data. */
  private bpm(): number {
    if (this.recentBeatTimes.length < 4) return 0;
    const intervals: number[] = [];
    for (let i = 1; i < this.recentBeatTimes.length; i++) {
      intervals.push(this.recentBeatTimes[i] - this.recentBeatTimes[i - 1]);
    }
    // Discard outliers (top/bottom 15%), average the rest
    intervals.sort((a, b) => a - b);
    const trim = Math.floor(intervals.length * 0.15);
    const core = intervals.slice(trim, intervals.length - trim);
    if (core.length === 0) return 0;
    const avgMs = core.reduce((a, b) => a + b, 0) / core.length;
    const bpm = 60_000 / avgMs;
    // Clamp to sensible music range
    if (bpm < 60 || bpm > 220) return 0;
    return Math.round(bpm);
  }

  reset(): void {
    this.history = [];
    this.recentBeatTimes = [];
    this.lastBeatMs = 0;
  }
}
