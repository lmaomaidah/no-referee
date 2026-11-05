import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  N, canonical, sha256hex, commitment, randomScalar, randomNonce,
  makeChain, seedForRound, checkSeed, split, combine, recoverS0,
} from './crypto.ts'

const subsets = <T>(a: T[], k: number): T[][] =>
  k === 0 ? [[]] : a.flatMap((v, i) => subsets(a.slice(i + 1), k - 1).map(s => [v, ...s]))

test('canonical: key order independent, sorted, no whitespace', () => {
  assert.equal(canonical({ b: 1, a: [{ d: null, c: 'x' }] }), '{"a":[{"c":"x","d":null}],"b":1}')
  assert.equal(canonical({ a: 1, b: { c: 2, d: 3 } }), canonical({ b: { d: 3, c: 2 }, a: 1 }))
})

test('canonical: throws on values JSON cannot represent', () => {
  for (const v of [undefined, { a: undefined }, [undefined], NaN, Infinity, () => 1])
    assert.throws(() => canonical(v), TypeError)
})

test('sha256hex: known vector, strings hash as utf8', () => {
  assert.equal(sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256hex(new TextEncoder().encode('abc')), sha256hex('abc'))
})

test('commitment: changes with every bound field', () => {
  const move = { a: 'hide' }, base = commitment('g', 1, 'p', move, 'n')
  assert.equal(base, commitment('g', 1, 'p', { a: 'hide' }, 'n'))
  assert.notEqual(base, commitment('g2', 1, 'p', move, 'n'))
  assert.notEqual(base, commitment('g', 2, 'p', move, 'n'))
  assert.notEqual(base, commitment('g', 1, 'p2', move, 'n'))
  assert.notEqual(base, commitment('g', 1, 'p', { a: 'pickup' }, 'n'))
  assert.notEqual(base, commitment('g', 1, 'p', move, 'n2'))
})

test('randomScalar and randomNonce: in range, fresh', () => {
  const s = randomScalar()
  assert.ok(s > 0n && s < N)
  assert.notEqual(s, randomScalar())
  assert.match(randomNonce(), /^[0-9a-f]{64}$/)
})

test('chain: every round checks against tip, wrong round fails', () => {
  const R = 5, chain = makeChain(randomScalar(), R), tip = chain.at(-1)!
  assert.equal(chain.length, R + 3)
  for (let r = 0; r <= R; r++) {
    const seed = seedForRound(chain, r)
    assert.ok(checkSeed(seed, r, tip))
    assert.ok(!checkSeed(seed, r + 1, tip))
    if (r > 0) assert.ok(!checkSeed(seed, r - 1, tip))
  }
})

test('chain: s0 is 32 bytes big-endian, so small values are left padded', () => {
  assert.equal(makeChain(1n, 1)[0], '0'.repeat(63) + '1')
})

test('seedForRound: refuses rounds outside 0..R, never exposing c_0', () => {
  const chain = makeChain(randomScalar(), 3)
  assert.throws(() => seedForRound(chain, 4), RangeError)
  assert.throws(() => seedForRound(chain, -1), RangeError)
})

test('checkSeed: only lowercase hex, since seeds feed random_r as strings', () => {
  const chain = makeChain(randomScalar(), 3), tip = chain.at(-1)!, seed = seedForRound(chain, 1)
  assert.ok(!checkSeed(seed.toUpperCase(), 1, tip))
  assert.ok(!checkSeed('not hex', 1, tip))
})

test('shamir: any k of n recovers, any k-1 does not', () => {
  for (const [n, k] of [[4, 3], [5, 3], [6, 4]]) {
    const s0 = randomScalar(), shares = split(s0, n, k), tip = makeChain(s0, 3).at(-1)!
    assert.deepEqual(shares.map(s => s.x), Array.from({ length: n }, (_, i) => i + 1))
    for (const sub of subsets(shares, k)) assert.equal(combine(sub), s0)
    for (const sub of subsets(shares, k - 1)) {
      assert.notEqual(combine(sub), s0)
      assert.equal(recoverS0(sub, k, tip, 3), null)
    }
  }
})

test('shamir: rejects bad parameters and duplicate x', () => {
  assert.throws(() => split(0n, 4, 3), RangeError)
  assert.throws(() => split(N, 4, 3), RangeError)
  assert.throws(() => split(1n, 3, 4), RangeError)
  const [a, b] = split(5n, 4, 2)
  assert.throws(() => combine([a, { ...b, x: a.x }]), RangeError)
})

test('recoverS0: finds s0 past a bad share, in any input order', () => {
  const s0 = randomScalar(), R = 4, tip = makeChain(s0, R).at(-1)!, shares = split(s0, 5, 3)
  shares[0] = { x: 1, y: 'f'.repeat(63) + '0' }
  assert.equal(recoverS0(shares, 3, tip, R), s0)
  assert.equal(recoverS0([...shares].reverse(), 3, tip, R), s0)
})

test('recoverS0: two versions of one share do not break it', () => {
  const s0 = randomScalar(), tip = makeChain(s0, 2).at(-1)!, shares = split(s0, 4, 3)
  assert.equal(recoverS0([{ x: 1, y: '0'.repeat(63) + '1' }, ...shares], 3, tip, 2), s0)
})

test('recoverS0: null when too many shares are bad or tip is wrong', () => {
  const s0 = randomScalar(), tip = makeChain(s0, 2).at(-1)!, shares = split(s0, 4, 3)
  const bad = shares.map((s, i) => (i < 2 ? { x: s.x, y: '0'.repeat(63) + 'a' } : s))
  assert.equal(recoverS0(bad, 3, tip, 2), null)
  assert.equal(recoverS0(shares, 3, 'f'.repeat(64), 2), null)
})
