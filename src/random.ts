import type { Rng } from './types.js';

const NONCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createRng(seed?: number): Rng {
  const resolvedSeed = normalizeSeed(seed ?? Date.now() % 2147483647);
  let state = resolvedSeed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    seed: resolvedSeed,
    next,
    int(minInclusive: number, maxExclusive: number): number {
      if (maxExclusive <= minInclusive) return minInclusive;
      return minInclusive + Math.floor(next() * (maxExclusive - minInclusive));
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('rng.pick: empty list');
      const index = Math.floor(next() * items.length);
      return items[Math.min(index, items.length - 1)] as T;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const a = copy[i] as T;
        const b = copy[j] as T;
        copy[i] = b;
        copy[j] = a;
      }
      return copy;
    },
    bool(pTrue = 0.5): boolean {
      return next() < pTrue;
    },
    nonce(length = 6): string {
      let out = '';
      for (let i = 0; i < length; i += 1) {
        out += NONCE_ALPHABET[Math.floor(next() * NONCE_ALPHABET.length)];
      }
      return out;
    },
  };
}

function normalizeSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 1;
  const truncated = Math.trunc(seed);
  const positive = ((truncated % 2147483647) + 2147483647) % 2147483647;
  return positive === 0 ? 1 : positive;
}
