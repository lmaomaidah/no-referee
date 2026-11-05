import { finalizeEvent, getPublicKey, validateEvent, verifyEvent } from 'nostr-tools/pure'
import type { Event } from 'nostr-tools/pure'
import * as nip44 from 'nostr-tools/nip44'
import { N, canonical, sha256hex } from './crypto.ts'
import type { Share } from './crypto.ts'

export const KIND = { setup: 7300, commit: 7301, reveal: 7302, recover: 7303, chat: 7304 } as const

export type Config = { roster: string[], k: number, rounds: number, salt: string }
type Dir = 'N' | 'E' | 'S' | 'W'
export type Move = { a: 'move', dir: Dir } | { a: 'attack', dir: Dir } | { a: 'hide' } | { a: 'pickup' }

type Common = { event: Event, pubkey: string, round: number }
export type Setup = Common & { type: 'setup', tip: string, shares: Record<string, string> }
export type Commit = Common & { type: 'commit', h: string, state: string }
export type Reveal = Common & { type: 'reveal', move: Move, nonce: string, seed: string }
export type Recover = Common & { type: 'recover', target: string, share: Share }
export type Chat = Common & { type: 'chat', to: string, ct: string }
export type Parsed = Setup | Commit | Reveal | Recover | Chat

export function gameId(config: Config): string {
  return sha256hex(canonical(config))
}

function sign(config: Config, sk: Uint8Array, kind: number, round: number, content: unknown) {
  const tags = [['g', gameId(config)], ['r', String(round)]]
  return finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags, content: canonical(content) }, sk)
}

const seal = (sk: Uint8Array, to: string, text: string) => nip44.encrypt(text, nip44.getConversationKey(sk, to))

/** shares come from split(), and each goes to the roster member at index x - 1. */
export function buildSetup(config: Config, sk: Uint8Array, tip: string, shares: Share[]) {
  const sealed = shares.map(s => [config.roster[s.x - 1], seal(sk, config.roster[s.x - 1], canonical(s))])
  return sign(config, sk, KIND.setup, 0, { tip, shares: Object.fromEntries(sealed) })
}

export function buildCommit(config: Config, sk: Uint8Array, round: number, h: string, state: string) {
  return sign(config, sk, KIND.commit, round, { h, state })
}

export function buildReveal(config: Config, sk: Uint8Array, round: number, move: Move, nonce: string, seed: string) {
  return sign(config, sk, KIND.reveal, round, { move, nonce, seed })
}

export function buildRecover(config: Config, sk: Uint8Array, round: number, target: string, share: Share) {
  return sign(config, sk, KIND.recover, round, { target, share })
}

export function buildChat(config: Config, sk: Uint8Array, round: number, to: string, text: string) {
  return sign(config, sk, KIND.chat, round, { to, ct: seal(sk, to, text) })
}

// typeof first: RegExp.test coerces, so ['aa..'] would otherwise pass.
const isHex = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

function hasKeys(o: unknown, ...keys: string[]): o is Record<string, any> {
  return typeof o === 'object' && o !== null && !Array.isArray(o)
    && canonical(Object.keys(o).sort()) === canonical(keys.sort())
}

function isMove(m: any): m is Move {
  if (m?.a === 'hide' || m?.a === 'pickup') return hasKeys(m, 'a')
  return (m?.a === 'move' || m?.a === 'attack') && hasKeys(m, 'a', 'dir') && ['N', 'E', 'S', 'W'].includes(m.dir)
}

function isShare(s: unknown, config: Config, holder: string): s is Share {
  return hasKeys(s, 'x', 'y') && s.x === config.roster.indexOf(holder) + 1 && isHex(s.y) && BigInt('0x' + s.y) < N
}

/** Trust boundary: returns the typed event, or null for anything invalid. Never throws. */
export function parse(event: unknown, config: Config): Parsed | null {
  try {
    const { id, pubkey, created_at, kind, tags, content, sig } = event as Event
    // A fresh object: verifyEvent trusts a cached flag that survives mutation and {...event}.
    const ev = { id, pubkey, created_at, kind, tags, content, sig }
    if (!validateEvent(ev) || !verifyEvent(ev) || !config.roster.includes(pubkey)) return null

    const r = tags[1]?.[1]
    if (!/^(0|[1-9]\d*)$/.test(r) || Number(r) > config.rounds) return null
    if (canonical(tags) !== canonical([['g', gameId(config)], ['r', r]])) return null
    const round = Number(r), base = { event: ev, pubkey, round }

    const c = JSON.parse(content)
    if (canonical(c) !== content) return null

    switch (kind) {
      case KIND.setup:
        if (round !== 0 || !hasKeys(c, 'tip', 'shares') || !isHex(c.tip) || !hasKeys(c.shares, ...config.roster)) return null
        if (!Object.values(c.shares).every(s => typeof s === 'string')) return null
        return { ...base, type: 'setup', tip: c.tip, shares: c.shares }
      case KIND.commit:
        if (!hasKeys(c, 'h', 'state') || !isHex(c.h) || !isHex(c.state)) return null
        return { ...base, type: 'commit', h: c.h, state: c.state }
      case KIND.reveal:
        if (!hasKeys(c, 'move', 'nonce', 'seed') || !isMove(c.move) || !isHex(c.nonce) || !isHex(c.seed)) return null
        return { ...base, type: 'reveal', move: c.move, nonce: c.nonce, seed: c.seed }
      case KIND.recover:
        if (!hasKeys(c, 'target', 'share') || !config.roster.includes(c.target) || !isShare(c.share, config, pubkey)) return null
        return { ...base, type: 'recover', target: c.target, share: c.share }
      case KIND.chat:
        if (!hasKeys(c, 'to', 'ct') || !config.roster.includes(c.to) || typeof c.ct !== 'string') return null
        return { ...base, type: 'chat', to: c.to, ct: c.ct }
      default:
        return null
    }
  } catch {
    return null
  }
}

/** The share addressed to sk's owner, or null if it is missing, undecryptable or not that holder's share. */
export function decryptShare(setup: Setup, sk: Uint8Array, config: Config): Share | null {
  try {
    const me = getPublicKey(sk)
    const share = JSON.parse(nip44.decrypt(setup.shares[me], nip44.getConversationKey(sk, setup.pubkey)))
    return isShare(share, config, me) ? share : null
  } catch {
    return null
  }
}
