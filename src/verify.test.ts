import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { commitment, makeChain, randomNonce, randomScalar, seedForRound, split } from './crypto.ts'
import { buildCommit, buildRecover, buildReveal, buildSetup, gameId, parse } from './protocol.ts'
import type { Config, Move } from './protocol.ts'
import { stateHash } from './game.ts'
import { verify } from './verify.ts'

const R = 6

/** A table of honest players that can be told to misbehave one event at a time. */
function table(n = 4) {
  const sks = Array.from({ length: n }, () => generateSecretKey())
  sks.sort((a, b) => (getPublicKey(a) < getPublicKey(b) ? -1 : 1))
  const roster = sks.map(sk => getPublicKey(sk))
  const config: Config = { roster, k: Math.floor(n / 2) + 1, rounds: R, salt: 'aa' }
  const id = gameId(config)
  const chains = sks.map(() => { const s0 = randomScalar(); return { s0, chain: makeChain(s0, R) } })
  const shares = chains.map(c => split(c.s0, n, config.k))
  const log: unknown[] = sks.map((sk, i) => buildSetup(config, sk, chains[i].chain.at(-1)!, shares[i]))

  const commit = (i: number, r: number, move: Move, state: string) => {
    const nonce = randomNonce()
    return { c: buildCommit(config, sks[i], r, commitment(id, r, roster[i], move, nonce), state), nonce }
  }
  const reveal = (i: number, r: number, move: Move, nonce: string) =>
    buildReveal(config, sks[i], r, move, nonce, seedForRound(chains[i].chain, r))
  const vote = (voter: number, r: number, target: number) =>
    buildRecover(config, sks[voter], r, roster[target], shares[target][voter])

  /** Plays round r honestly with `hide` for the players in `who`, returns the state hash used. */
  const honest = (r: number, who: number[]) => {
    const state = r === 0 ? id : stateHash(verify(log, config).rounds.at(-1)!.state)
    const hide: Move = { a: 'hide' }
    const made = who.map(i => ({ i, ...commit(i, r, hide, state) }))
    log.push(...made.map(m => m.c), ...made.map(m => reveal(m.i, r, hide, m.nonce)))
    return state
  }
  return { sks, roster, config, id, shares, log, commit, reveal, vote, honest }
}

/** Round 0 played by all, round 1 played by players 0-2 only. Player 3 is the one under test. */
function round1() {
  const t = table()
  t.honest(0, [0, 1, 2, 3])
  return { ...t, state: t.honest(1, [0, 1, 2]) }
}

const shuffled = <T>(a: T[]) => a.map(v => [Math.random(), v] as const).sort((x, y) => x[0] - y[0]).map(x => x[1])
const kinds = (t: { config: Config, log: unknown[] }) => verify(t.log, t.config).cheats.map(c => c.type)

test('honest game finishes, and any event order gives the same result', () => {
  const t = table()
  for (let r = 0; r <= R; r++) t.honest(r, [0, 1, 2, 3])
  const a = verify(t.log, t.config)
  assert.equal(a.status, 'finished')
  assert.ok(a.winner)
  assert.deepEqual(a.cheats, [])
  assert.deepEqual(verify(shuffled(t.log), t.config), a)
  assert.deepEqual(verify([...t.log, ...t.log], t.config), a, 'relay duplicates change nothing')
})

test('stops at the first missing piece and names who it waits for', () => {
  const t = round1()
  const res = verify(t.log, t.config)
  assert.equal(res.status, 'stalled')
  assert.equal(res.pending?.round, 1)
  assert.deepEqual(res.pending?.noCommit, [t.roster[3]])
  assert.deepEqual(res.pending?.noSeed, [t.roster[3]])
})

test('quitter: k votes eject it and the rebuilt seed gives the same randomness', () => {
  const t = round1()
  const { c, nonce } = t.commit(3, 1, { a: 'hide' }, t.state)
  const full = verify([...t.log, c, t.reveal(3, 1, { a: 'hide' }, nonce)], t.config).rounds[1].random

  const log = [...t.log, c, t.vote(0, 1, 3), t.vote(1, 1, 3)]
  assert.equal(verify(log, t.config).pending?.round, 1, 'a minority cannot eject anyone')
  log.push(t.vote(2, 1, 3))
  const res = verify(log, t.config)
  assert.equal(res.rounds[1].random, full, 'quitting cannot change the outcome')
  assert.equal(res.rounds[1].moves[t.roster[3]], null)
  assert.deepEqual(res.cheats.map(x => [x.pubkey, x.type]), [[t.roster[3], 'absent']])
  assert.equal(res.rounds[1].state.players[t.roster[3]].alive, false)
})

test('bad dealer cannot stall the game by withholding', () => {
  const t = round1()
  t.shares[3] = split(randomScalar(), 4, t.config.k)  // shares of some other secret
  t.log.push(t.commit(3, 1, { a: 'hide' }, t.state).c, t.vote(0, 1, 3), t.vote(1, 1, 3), t.vote(2, 1, 3))
  assert.equal(verify(t.log, t.config).rounds.length, 2)
  assert.deepEqual(kinds(t), ['absent'])
})

test('equivocation is proven by two signed commits', () => {
  const t = round1()
  const a = t.commit(3, 1, { a: 'hide' }, t.state), b = t.commit(3, 1, { a: 'pickup' }, t.state)
  t.log.push(a.c, b.c, t.reveal(3, 1, { a: 'hide' }, a.nonce))
  const [cheat] = verify(t.log, t.config).cheats
  assert.equal(cheat.type, 'equivocation')
  assert.equal(cheat.pubkey, t.roster[3])
  assert.deepEqual([...cheat.evidence].sort(), [a.c.id, b.c.id].sort())
})

test('changing a move after seeing others is a bad reveal', () => {
  const t = round1()
  const { c, nonce } = t.commit(3, 1, { a: 'hide' }, t.state)
  t.log.push(c, t.reveal(3, 1, { a: 'pickup' }, nonce))
  const res = verify(t.log, t.config)
  assert.deepEqual(res.cheats.map(x => [x.pubkey, x.type]), [[t.roster[3], 'bad-reveal']])
  assert.equal(res.rounds[1].moves[t.roster[3]], null)
})

test('a seed that breaks the chain is a bad reveal and needs recovery', () => {
  const t = round1()
  const { c, nonce } = t.commit(3, 1, { a: 'hide' }, t.state)
  t.log.push(c, buildReveal(t.config, t.sks[3], 1, { a: 'hide' }, nonce, 'ab'.repeat(32)))
  assert.deepEqual(verify(t.log, t.config).pending?.noSeed, [t.roster[3]])
  t.log.push(t.vote(0, 1, 3), t.vote(1, 1, 3), t.vote(2, 1, 3))
  assert.deepEqual(kinds(t), ['bad-reveal'])
  assert.equal(verify(t.log, t.config).rounds.length, 2)
})

test('a move the rules forbid is caught', () => {
  const t = round1()
  const { c, nonce } = t.commit(3, 1, { a: 'pickup' }, t.state)  // nothing to pick up in round 1
  t.log.push(c, t.reveal(3, 1, { a: 'pickup' }, nonce))
  assert.deepEqual(kinds(t), ['illegal-move'])
})

test('lying about the state is caught', () => {
  const t = round1()
  const { c, nonce } = t.commit(3, 1, { a: 'hide' }, 'ee'.repeat(32))
  t.log.push(c, t.reveal(3, 1, { a: 'hide' }, nonce))
  assert.deepEqual(kinds(t), ['state-fork'])
})

test('forgery is rejected and the victim is not blamed', () => {
  const t = round1(), outsider = generateSecretKey()
  const { c, nonce } = t.commit(3, 1, { a: 'hide' }, t.state)
  const forged = { id: c.id, pubkey: c.pubkey, created_at: c.created_at, kind: c.kind, tags: c.tags, sig: c.sig, content: c.content.replace('"h":"', '"h":"0') }
  const stranger = buildCommit({ ...t.config, roster: [getPublicKey(outsider)] }, outsider, 1, 'aa'.repeat(32), t.state)
  t.log.push(forged, stranger, c, t.reveal(3, 1, { a: 'hide' }, nonce), 'garbage', null)
  const res = verify(t.log, t.config)
  assert.equal(res.rejected, 4)
  assert.deepEqual(res.cheats, [])
  assert.equal(res.rounds[1].moves[t.roster[3]]?.a, 'hide')
})

test('a forgery reusing a real event id cannot displace the real event', () => {
  const t = table()
  t.honest(0, [0, 1, 2, 3])
  const c = t.log[5] as any
  assert.ok(parse(c, t.config))
  const fake = { id: c.id, pubkey: c.pubkey, created_at: c.created_at, kind: c.kind, tags: c.tags, content: c.content, sig: '00'.repeat(64) }
  assert.equal(verify([fake, ...t.log], t.config).rounds.length, 1)
  assert.equal(verify([...t.log, fake], t.config).rounds.length, 1)
})

test('a voter signing two different shares is caught', () => {
  const t = round1()
  t.log.push(t.commit(3, 1, { a: 'hide' }, t.state).c, t.vote(0, 1, 3), t.vote(1, 1, 3), t.vote(2, 1, 3))
  t.log.push(buildRecover(t.config, t.sks[0], 1, t.roster[3], { x: 1, y: 'cd'.repeat(32) }))
  const res = verify(t.log, t.config)
  assert.deepEqual(res.cheats.map(x => [x.pubkey, x.type]).sort(),
    [[t.roster[0], 'equivocation'], [t.roster[3], 'absent']].sort())
})

test('an ejected voter loses its move for that round', () => {
  const t = round1()
  t.log.push(t.commit(3, 1, { a: 'hide' }, t.state).c, t.vote(0, 1, 3), t.vote(1, 1, 3), t.vote(2, 1, 3))
  t.log.push(buildRecover(t.config, t.sks[0], 1, t.roster[3], { x: 1, y: 'cd'.repeat(32) }))
  assert.equal(verify(t.log, t.config).rounds[1].moves[t.roster[0]], null)
})

test('a target cannot vote for itself to reach quorum', () => {
  const t = round1()
  t.log.push(t.commit(3, 1, { a: 'hide' }, t.state).c, t.vote(0, 1, 3), t.vote(1, 1, 3), t.vote(3, 1, 3))
  assert.equal(verify(t.log, t.config).pending?.round, 1)
})

test('the same move re-signed at another time is not equivocation', () => {
  const t = round1()
  const { c, nonce } = t.commit(3, 1, { a: 'hide' }, t.state)
  const content = JSON.parse(c.content)
  const twin = finalizeEvent({ kind: c.kind, created_at: c.created_at + 5, tags: c.tags, content: c.content }, t.sks[3])
  assert.equal(content.state, t.state)
  t.log.push(c, twin, t.reveal(3, 1, { a: 'hide' }, nonce))
  assert.deepEqual(kinds(t), [])
})
