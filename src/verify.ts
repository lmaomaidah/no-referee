import { canonical, checkSeed, commitment, makeChain, recoverS0, seedForRound, sha256hex } from './crypto.ts'
import { gameId, parse } from './protocol.ts'
import type { Commit, Config, Move, Parsed, Recover, Reveal, Setup } from './protocol.ts'
import { applyRound, legalMove, spawn, stateHash, winner } from './game.ts'
import type { State } from './game.ts'

export type CheatType = 'equivocation' | 'bad-reveal' | 'illegal-move' | 'state-fork' | 'absent'
export type Cheat = { pubkey: string, round: number, type: CheatType, evidence: string[] }
export type Round = { round: number, random: string, moves: Record<string, Move | null>, state: State }

/** Why the log stops here. Live players act on this, so play and replay share one rulebook. */
export type Pending = {
  round: number,
  state: State | null,         // null until round 0 finishes
  alive: string[],
  noSetup: string[],
  noCommit: string[],          // alive, no commit, no quorum: blocks every reveal
  noSeed: string[],            // alive, no usable seed yet, no quorum
}
export type Result = {
  status: 'finished' | 'stalled', winner: string | null,
  rounds: Round[], cheats: Cheat[], rejected: number, pending: Pending | null,
}

const byId = <T extends Parsed>(a: T, b: T) => (a.event.id < b.event.id ? -1 : 1)

/** Same-content copies are one claim: only differing content is equivocation. */
function distinct<T extends Parsed>(list: T[] = []): T[] {
  const seen = new Map<string, T>()
  for (const e of [...list].sort(byId)) if (!seen.has(e.event.content)) seen.set(e.event.content, e)
  return [...seen.values()]
}

function group<T extends Parsed>(events: Parsed[], type: T['type'], key: (e: T) => string) {
  const m = new Map<string, T[]>()
  for (const e of events) if (e.type === type) {
    const k = key(e as T)
    m.set(k, [...(m.get(k) ?? []), e as T])
  }
  return m
}

const twoIds = (l: Parsed[]) => l.slice(0, 2).map(e => e.event.id)

/** Replays already-parsed events. Pure and order-independent. */
export function replay(events: Parsed[], config: Config, rejected = 0): Result {
  const id = gameId(config), R = config.rounds
  const setups = group<Setup>(events, 'setup', e => e.pubkey)
  const commits = group<Commit>(events, 'commit', e => `${e.round}:${e.pubkey}`)
  const reveals = group<Reveal>(events, 'reveal', e => `${e.round}:${e.pubkey}`)
  const recovers = group<Recover>(events, 'recover', e => `${e.round}:${e.target}`)

  const rounds: Round[] = [], cheats: Cheat[] = []
  const stop = (pending: Pending): Result =>
    ({ status: 'stalled', winner: null, rounds, cheats, rejected, pending })

  const noSetup = config.roster.filter(p => !setups.has(p))
  if (noSetup.length) return stop({ round: 0, state: null, alive: config.roster, noSetup, noCommit: [], noSeed: [] })

  const tips = new Map(config.roster.map(p => [p, distinct(setups.get(p))[0].tip]))
  let state: State | null = null

  for (let r = 0; r <= R; r++) {
    const alive = config.roster.filter(p => state === null || state.players[p].alive)
    const expected = state === null ? id : stateHash(state)
    const seeds = new Map<string, string>(), moves: Record<string, Move | null> = {}
    const found: Cheat[] = [], noCommit: string[] = [], noSeed: string[] = []

    // A voter who signs two different shares for one target is caught, alive or not.
    const voters = new Map<string, Recover[]>()
    for (const p of config.roster) {
      const votes = distinct(recovers.get(`${r}:${p}`)).filter(v => v.pubkey !== p)
      for (const [voter, list] of group<Recover>(votes, 'recover', v => v.pubkey)) {
        if (list.length > 1) found.push({ pubkey: voter, round: r, type: 'equivocation', evidence: twoIds(list) })
      }
      voters.set(p, [...new Map(votes.reverse().map(v => [v.pubkey, v])).values()].sort(byId))
    }

    for (const p of alive) {
      const c = distinct(commits.get(`${r}:${p}`)), v = distinct(reveals.get(`${r}:${p}`))
      const votes = voters.get(p)!, quorum = votes.length >= config.k
      const tip = tips.get(p)!
      const good = v.find(e => checkSeed(e.seed, r, tip))

      if (good) seeds.set(p, good.seed)
      else if (quorum) {
        const s0 = recoverS0(votes.map(e => e.share), config.k, tip, R)
        seeds.set(p, s0 === null ? sha256hex(canonical(['no-seed', id, r, p])) : seedForRound(makeChain(s0, R), r))
      } else noSeed.push(p)
      if (!c.length && !quorum) noCommit.push(p)

      const setup = distinct(setups.get(p))
      const twoFaced = r === 0 && setup.length > 1 ? setup : c.length > 1 ? c : v.length > 1 ? v : null
      const matches = c[0] && v[0] && !twoFaced && commitment(id, r, p, v[0].move, v[0].nonce) === c[0].h

      let move: Move | null = null, cheat: Cheat | null = null
      const say = (type: CheatType, evidence: string[]) => { cheat = { pubkey: p, round: r, type, evidence } }
      if (twoFaced) say('equivocation', twoIds(twoFaced))
      else if (c[0] && v[0] && (!matches || !good)) say('bad-reveal', [c[0].event.id, v[0].event.id])
      else if (c[0] && c[0].state !== expected) say('state-fork', [c[0].event.id])
      else if (matches && !(state === null ? v[0].move.a === 'hide' : legalMove(state, p, v[0].move))) say('illegal-move', [v[0].event.id])
      else if (quorum) say('absent', votes.map(e => e.event.id))
      else if (matches) move = v[0].move

      if (cheat) found.push(cheat)
      moves[p] = move
    }

    if (noSeed.length || noCommit.length) return stop({ round: r, state, alive, noSetup: [], noCommit, noSeed })

    cheats.push(...found)
    const ejected = new Set(found.map(c => c.pubkey))
    for (const p of ejected) if (p in moves) moves[p] = null
    const random = sha256hex(canonical([id, r, alive.map(p => seeds.get(p))]))

    const remove = (s: State): State => ({
      ...s,
      players: Object.fromEntries(Object.entries(s.players).map(
        ([p, v]) => [p, ejected.has(p) ? { ...v, alive: false } : v])),
    })
    const next: State = state === null ? remove(spawn(config.roster, random)) : applyRound(remove(state), moves, random)
    rounds.push({ round: r, random, moves, state: next })
    state = next

    const left = config.roster.filter(p => next.players[p].alive)
    if (r > 0 && left.length <= 1 || r === R) {
      return { status: 'finished', winner: winner(next, random, r === R), rounds, cheats, rejected, pending: null }
    }
  }
  throw new Error('unreachable: round R always finishes')
}

/** Anyone's entry point: raw event log in, result out. Trusts nothing in the log. */
export function verify(raw: unknown[], config: Config): Result {
  const good = new Map<string, Parsed>(), bad = new Set<string>()
  for (const e of raw) {
    const p = parse(e, config)
    // Keyed after parse: a forgery reusing a real id must not displace the real event.
    if (p) good.set(p.event.id, p)
    else bad.add(canonical(e ?? null))
  }
  return replay([...good.values()], config, bad.size)
}
