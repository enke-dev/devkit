/** The next index along a list, wrapping at either end. */
export function cycleIndex(current: number, delta: number, count: number): number {
  return current + delta < 0 ? count - 1 : (current + delta) % count;
}

/** A URL as the list shows it: the scheme says nothing you did not already know. */
export function withoutScheme(url: string): string {
  return url.replace(/^https?:\/\//, '');
}
