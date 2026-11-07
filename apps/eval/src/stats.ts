/**
 * Statistics on case counts, never on money, so plain `number` is right here.
 * Each function takes whole counts and refuses anything else, because a
 * fractional or negative count means the caller passed the wrong thing.
 */

/** The 97.5th percentile of the standard normal, for a two-sided 95% interval. */
const Z95 = 1.959963984540054;

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number of cases, got ${String(value)}`);
}

/**
 * Wilson score interval for k successes out of n, at 95%. Chosen over the
 * normal approximation because that one gives 0 to 0 for 0 of 21, which would
 * claim certainty a sample of 21 can't give. At k = 0 the upper bound is
 * z²/(n + z²), so 0 of 21 is "somewhere under 15.5%".
 */
export function wilson95(k: number, n: number): { low: number; high: number } {
  assertCount("k", k);
  assertCount("n", n);
  if (n === 0) throw new RangeError("an interval needs at least one case");
  if (k > n) throw new RangeError(`k (${k.toString()}) can't exceed n (${n.toString()})`);

  const p = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // At the edges the exact bound is 0 or 1, and rounding can land a hair outside.
  return {
    low: k === 0 ? 0 : Math.max(0, centre - half),
    high: k === n ? 1 : Math.min(1, centre + half),
  };
}

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

/**
 * Two-sided Fisher exact test on the 2x2 table
 *
 *     a  b
 *     c  d
 *
 * With the row and column totals fixed, it sums the probability of every
 * table at most as likely as the observed one. Exact, so it holds at the
 * small counts this repo has, where a chi-squared test would not.
 */
export function fisherExactTwoSided(a: number, b: number, c: number, d: number): number {
  for (const [name, v] of [["a", a], ["b", b], ["c", c], ["d", d]] as const) assertCount(name, v);

  const row1 = a + b;
  const row2 = c + d;
  const col1 = a + c;
  const n = row1 + row2;
  const fixed = logFactorial(row1) + logFactorial(row2) + logFactorial(col1) + logFactorial(n - col1) - logFactorial(n);
  const probability = (x: number): number =>
    Math.exp(fixed - logFactorial(x) - logFactorial(row1 - x) - logFactorial(col1 - x) - logFactorial(row2 - col1 + x));

  const observed = probability(a);
  // Tables tied with the observed one must count, and floating point can
  // make a true tie look slightly larger.
  const tolerance = observed * 1e-7;
  let p = 0;
  for (let x = Math.max(0, col1 - row2); x <= Math.min(row1, col1); x++) {
    const px = probability(x);
    if (px <= observed + tolerance) p += px;
  }
  return Math.min(1, p);
}
