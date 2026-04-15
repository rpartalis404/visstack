/**
 * Small helpers for turning raw AudioFrame values into visually-smooth
 * driver signals. Prevents the 1-frame binary-beat "pops" that make
 * visualizations feel jumpy against music with syncopation or ghost notes.
 */

/**
 * Decaying envelope — rises to 1 instantly on a beat, decays exponentially
 * afterward. Use instead of `frame.beat ? 1 : 0` anywhere a beat should
 * cause a sustained visual effect rather than a one-frame pop.
 *
 *   decayPerSecond=4 → envelope reaches ~0 after 250ms
 *   decayPerSecond=2 → reaches ~0 after 500ms (longer-lingering beat feel)
 */
export class BeatEnvelope {
  private value = 0;
  constructor(private decayPerSecond: number = 4) {}

  update(beat: boolean, dt: number): number {
    if (beat) this.value = 1;
    this.value = Math.max(0, this.value - dt * this.decayPerSecond);
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

/**
 * One-pole exponential smoothing for a 0..1 driver. Filters out single-frame
 * spikes while keeping the overall envelope shape of the signal.
 *
 * `attack` and `release` let the smoother respond faster on rising edges
 * than falling ones (mirrors how audio envelope followers behave — perceived
 * transients feel punchy, releases feel natural). Both are "fractions of
 * current-to-target per 60fps frame" so values are intuitive.
 */
export class BandSmoother {
  private value = 0;
  constructor(
    private attack: number = 0.45,
    private release: number = 0.12,
  ) {}

  update(input: number): number {
    const rate = input > this.value ? this.attack : this.release;
    this.value = this.value + (input - this.value) * rate;
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}
