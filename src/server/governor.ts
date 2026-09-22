/** Recent completed steps, including persistence. This is not a lifetime percentile. */
export const GOVERNOR_WINDOW_STEPS = 120;

/** Shared by the server and experiments so both use the same window and percentile. */
export class RollingStepPerformance {
  private readonly measurements: number[] = [];

  get count(): number { return this.measurements.length; }

  record(stepMs: number): number {
    this.measurements.push(stepMs);
    if (this.measurements.length > GOVERNOR_WINDOW_STEPS) this.measurements.shift();
    return [...this.measurements].sort((a, b) => a - b)[Math.floor(this.measurements.length * 0.95)]!;
  }
}

/**
 * R17: preserve the hardware budget and its hysteresis. Load in [70 %, 100 %]
 * keeps the current state; falling below 70 % permits births again, never forces them.
 */
export function decideReproduction(p95StepMs: number, presupuestoMs: number, actual: boolean): boolean {
  if (p95StepMs > presupuestoMs) return false;
  if (p95StepMs < presupuestoMs * 0.7) return true;
  return actual;
}
