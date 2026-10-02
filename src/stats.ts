export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function variance(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((acc, x) => acc + (x - m) * (x - m), 0) / (xs.length - 1);
}

export function stdev(xs: readonly number[]): number {
  return Math.sqrt(variance(xs));
}

export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  if (Number.isNaN(q)) return quantile(sorted, 0.5);
  const clamped = Math.min(1, Math.max(0, q));
  const pos = (sorted.length - 1) * clamped;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower] as number;
  const weight = pos - lower;
  return (sorted[lower] as number) * (1 - weight) + (sorted[upper] as number) * weight;
}

export function median(xs: readonly number[]): number {
  return quantile(xs, 0.5);
}

export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

export interface Regression {
  slope: number;
  intercept: number;
  r2: number;
  n: number;
}

export function linearRegression(xs: readonly number[], ys: readonly number[]): Regression {
  if (xs.length !== ys.length || xs.length < 2) {
    return { slope: 0, intercept: 0, r2: 0, n: Math.min(xs.length, ys.length) };
  }
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return { slope: 0, intercept: my, r2: 0, n: xs.length };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n: xs.length };
}

export function wilsonLowerBound(successes: number, total: number, z = 1.64): number {
  if (total === 0) return 0;
  const clampedSuccesses = Math.max(0, Math.min(total, successes));
  const p = clampedSuccesses / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return Math.max(0, (center - spread) / denom);
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
