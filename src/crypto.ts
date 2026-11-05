import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

/** secp256k1 group order. */
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/** x is the holder's index in the sorted roster + 1. y is 64 lowercase hex chars. */
export type Share = { x: number, y: string }

/** Sorted keys, no whitespace. Throws TypeError on anything JSON cannot represent. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  const s = JSON.stringify(v)
  if (s === undefined || (typeof v === 'number' && !Number.isFinite(v))) throw new TypeError(`not JSON: ${String(v)}`)
  return s
}

/** Strings hash as their utf8 bytes, so a hex string is not decoded first. */
export function sha256hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data))
}

export function commitment(gameId: string, round: number, pubkey: string, move: unknown, nonce: string): string {
  return sha256hex(canonical([gameId, round, pubkey, move, nonce]))
}

export function randomNonce(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
}

/** Uniform in [1, N): rejection sampling, so no modulo bias. */
export function randomScalar(): bigint {
  for (;;) {
    const s = BigInt('0x' + randomNonce())
    if (s > 0n && s < N) return s
  }
}

const scalarHex = (s: bigint) => s.toString(16).padStart(64, '0')

/** [c_0, ..., c_(R+2)] as hex. c_0 encodes s0 and must stay secret; the last entry is the tip. */
export function makeChain(s0: bigint, rounds: number): string[] {
  const chain = [scalarHex(s0)]
  for (let i = 0; i < rounds + 2; i++) chain.push(sha256hex(hexToBytes(chain[i])))
  return chain
}

export function seedForRound(chain: string[], round: number): string {
  if (!Number.isInteger(round) || round < 0 || round > chain.length - 3) throw new RangeError(`bad round ${round}`)
  return chain[chain.length - 2 - round]
}

/** Lowercase only: seeds feed random_r as strings, so case variants of one seed would let a player steer it. */
export function checkSeed(seed: string, round: number, tip: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(seed)) return false
  let c = seed
  for (let i = 0; i <= round; i++) c = sha256hex(hexToBytes(c))
  return c === tip
}

const mod = (a: bigint) => ((a % N) + N) % N

function inverse(a: bigint): bigint {
  let [r0, r1, t0, t1] = [N, mod(a), 0n, 1n]
  while (r1 !== 0n) {
    const q = r0 / r1
    ;[r0, r1, t0, t1] = [r1, r0 - q * r1, t1, t0 - q * t1]
  }
  return mod(t0)
}

export function split(secret: bigint, n: number, k: number): Share[] {
  if (secret <= 0n || secret >= N || k < 1 || k > n) throw new RangeError('bad split parameters')
  const coeffs = [secret, ...Array.from({ length: k - 1 }, randomScalar)]
  return Array.from({ length: n }, (_, i) => {
    const x = BigInt(i + 1)
    return { x: i + 1, y: scalarHex(coeffs.reduceRight((acc, c) => mod(acc * x + c), 0n)) }
  })
}

/** Lagrange interpolation at 0. Uses every share given, so pass exactly k. */
export function combine(shares: Share[]): bigint {
  if (new Set(shares.map(s => s.x)).size < shares.length) throw new RangeError('duplicate share x')
  let secret = 0n
  for (const a of shares) {
    let num = 1n, den = 1n
    for (const b of shares) {
      if (b.x === a.x) continue
      num = mod(num * BigInt(b.x))
      den = mod(den * BigInt(b.x - a.x))
    }
    secret = mod(secret + BigInt('0x' + a.y) * num * inverse(den))
  }
  return secret
}

/** Tries k-subsets in sorted order. Only the true s0 hashes to tip, so input order cannot change the answer. */
export function recoverS0(shares: Share[], k: number, tip: string, rounds: number): bigint | null {
  const sorted = [...shares].sort((a, b) => a.x - b.x || (a.y < b.y ? -1 : a.y > b.y ? 1 : 0))
  const pick = (from: number, chosen: Share[]): bigint | null => {
    if (chosen.length === k) {
      if (new Set(chosen.map(s => s.x)).size < k) return null
      const s0 = combine(chosen)
      return makeChain(s0, rounds).at(-1) === tip ? s0 : null
    }
    for (let i = from; i < sorted.length; i++) {
      const found = pick(i + 1, [...chosen, sorted[i]])
      if (found !== null) return found
    }
    return null
  }
  return pick(0, [])
}
