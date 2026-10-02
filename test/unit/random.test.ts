import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../../src/random.js';

test('same seed yields the same sequence', () => {
  const a = createRng(42);
  const b = createRng(42);
  for (let i = 0; i < 20; i += 1) assert.equal(a.next(), b.next());
});

test('different seeds diverge', () => {
  const a = createRng(1);
  const b = createRng(2);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  assert.notDeepEqual(seqA, seqB);
});

test('int bounds are inclusive/exclusive as documented', () => {
  const rng = createRng(7);
  for (let i = 0; i < 200; i += 1) {
    const v = rng.int(3, 9);
    assert.ok(v >= 3 && v < 9);
  }
});

test('nonce uses unambiguous charset and requested length', () => {
  const rng = createRng(9);
  for (let i = 0; i < 50; i += 1) {
    const nonce = rng.nonce(6);
    assert.equal(nonce.length, 6);
    assert.match(nonce, /^[A-Z2-9]+$/);
    assert.ok(!/[IO01]/.test(nonce));
  }
});

test('shuffle keeps the same elements', () => {
  const rng = createRng(3);
  const source = [1, 2, 3, 4, 5, 6, 7, 8];
  const shuffled = rng.shuffle(source);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), source);
});
