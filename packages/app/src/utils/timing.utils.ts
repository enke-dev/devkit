export interface Timings {
  count: number;
  p50: number;
  p95: number;
}

/** Median and tail of a set of durations, rounded to whole milliseconds. */
export function percentiles(samples: number[]): Timings {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) =>
    Math.round(sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0);
  return { count: sorted.length, p50: at(0.5), p95: at(0.95) };
}

/**
 * Summarise a sample list and empty it, so each report covers only the
 * interval since the last.
 */
export function takeTimings(samples: number[]): Timings {
  const timings = percentiles(samples);
  samples.length = 0;
  return timings;
}
