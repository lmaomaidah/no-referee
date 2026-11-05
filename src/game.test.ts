import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { spawn, applyRound, legalMove, stateHash, winner } from './game.ts'
import type { Move, State } from './game.ts'

const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(c => c.repeat(64))
const R = '00'.repeat(32)
const hide: Move = { a: 'hide' }
const go = (dir: 'N' | 'E' | 'S' | 'W'): Move => ({ a: 'move', dir })
const hit = (dir: 'N' | 'E' | 'S' | 'W'): Move => ({ a: 'attack', dir })

type P = State['players'][string]
// Mid-board players at round 1, so neither storm nor drops fire unless a test asks.
function st(players: Record<string, Partial<P>>, over: Partial<State> = {}): State {
  const out: State = { round: 1, safe: 8, players: {}, drops: [], fallen: [], ...over }
  for (const [k, v] of Object.entries(players)) {
    out.players[k] = { x: 3, y: 3, hp: 3, item: null, alive: true, hiding: false, ...v }
  }
  return out
}
const at = (s: State, k: string) => [s.players[k].x, s.players[k].y]

test('spawn: distinct in-grid cells, full hp, independent of roster order', () => {
  const s = spawn([A, B, C, D], R)
  assert.equal(s.round, 0)
  assert.equal(s.safe, 8)
  assert.deepEqual(s.drops, [])
  const cells = Object.values(s.players).map(p => `${p.x},${p.y}`)
  assert.equal(new Set(cells).size, 4)
  for (const p of Object.values(s.players)) {
    assert.ok(p.x >= 0 && p.x < 8 && p.y >= 0 && p.y < 8)
    assert.deepEqual([p.hp, p.item, p.alive], [3, null, true])
  }
  assert.deepEqual(spawn([D, C, B, A], R), s)
  assert.notDeepEqual(spawn([A, B, C, D], '11'.repeat(32)), s)
})

test('moves: N is y-1, E is x+1', () => {
  const s = applyRound(st({ [A]: { x: 2, y: 2 }, [B]: { x: 5, y: 5 } }), { [A]: go('N'), [B]: go('E') }, R)
  assert.deepEqual(at(s, A), [2, 1])
  assert.deepEqual(at(s, B), [6, 5])
  assert.equal(s.round, 2)
})

test('two players entering one cell both bounce', () => {
  const s = applyRound(st({ [A]: { x: 2, y: 3 }, [B]: { x: 4, y: 3 } }), { [A]: go('E'), [B]: go('W') }, R)
  assert.deepEqual(at(s, A), [2, 3])
  assert.deepEqual(at(s, B), [4, 3])
})

test('swap-through: two players swapping cells both bounce', () => {
  const s = applyRound(st({ [A]: { x: 3, y: 3 }, [B]: { x: 4, y: 3 } }), { [A]: go('E'), [B]: go('W') }, R)
  assert.deepEqual(at(s, A), [3, 3])
  assert.deepEqual(at(s, B), [4, 3])
})

test('entering a cell held by a stationary player bounces; the holder stays', () => {
  const s = applyRound(st({ [A]: { x: 3, y: 3 }, [B]: { x: 4, y: 3 } }), { [A]: go('E'), [B]: hide }, R)
  assert.deepEqual(at(s, A), [3, 3])
  assert.deepEqual(at(s, B), [4, 3])
})

test('following a player who leaves succeeds, a 4-cycle rotates, bounces cascade', () => {
  let s = applyRound(st({ [A]: { x: 3, y: 3 }, [B]: { x: 4, y: 3 } }), { [A]: go('E'), [B]: go('E') }, R)
  assert.deepEqual(at(s, A), [4, 3])
  assert.deepEqual(at(s, B), [5, 3])

  s = applyRound(
    st({ [A]: { x: 3, y: 3 }, [B]: { x: 4, y: 3 }, [C]: { x: 4, y: 4 }, [D]: { x: 3, y: 4 } }),
    { [A]: go('E'), [B]: go('S'), [C]: go('W'), [D]: go('N') }, R)
  assert.deepEqual([at(s, A), at(s, B), at(s, C), at(s, D)], [[4, 3], [4, 4], [3, 4], [3, 3]])

  // B and C collide at (5,3) and bounce, so A cannot follow into B's cell.
  s = applyRound(
    st({ [A]: { x: 3, y: 3 }, [B]: { x: 4, y: 3 }, [C]: { x: 6, y: 3 } }),
    { [A]: go('E'), [B]: go('E'), [C]: go('W') }, R)
  assert.deepEqual([at(s, A), at(s, B), at(s, C)], [[3, 3], [4, 3], [6, 3]])
})

test('dead players do not block cells', () => {
  const s = applyRound(st({ [A]: { x: 3, y: 3 }, [B]: { x: 4, y: 3, alive: false, hp: 0 } }), { [A]: go('E') }, R)
  assert.deepEqual(at(s, A), [4, 3])
})

test('attack hits the adjacent cell after moves', () => {
  const s0 = st({ [A]: { x: 3, y: 3 }, [B]: { x: 4, y: 3 } })
  assert.equal(applyRound(s0, { [A]: hit('E'), [B]: hide }, R).players[B].hp, 3)
  assert.equal(applyRound(s0, { [A]: hit('E'), [B]: hit('N') }, R).players[B].hp, 2)
  assert.equal(applyRound(s0, { [A]: hit('E'), [B]: go('E') }, R).players[B].hp, 3)
  const s1 = st({ [A]: { x: 3, y: 3 }, [B]: { x: 5, y: 3 } })
  assert.equal(applyRound(s1, { [A]: hit('E'), [B]: go('W') }, R).players[B].hp, 2)
})

test('attacks are simultaneous: a dying attacker still lands its hit', () => {
  const s = applyRound(st({ [A]: { x: 3, y: 3, hp: 1 }, [B]: { x: 4, y: 3, hp: 1 } }), { [A]: hit('E'), [B]: hit('W') }, R)
  assert.deepEqual([s.players[A].alive, s.players[B].alive], [false, false])
})

test('attack on a hider has no effect, void counts as hiding, shield is kept', () => {
  const s0 = st({ [A]: { x: 3, y: 3, item: 'knife' }, [B]: { x: 4, y: 3, item: 'shield' } })
  for (const m of [hide, null]) {
    const s = applyRound(s0, { [A]: hit('E'), [B]: m }, R)
    assert.deepEqual([s.players[B].hp, s.players[B].item, s.players[B].hiding], [3, 'shield', true])
  }
  assert.equal(applyRound(s0, { [A]: hit('E') }, R).players[B].hp, 3) // absent key means void
})

test('knife adds 1 and is kept; shield takes off 1 and is used up', () => {
  const dmg = (a: P['item'], b: P['item']) => {
    const s = applyRound(st({ [A]: { x: 3, y: 3, item: a }, [B]: { x: 4, y: 3, item: b } }), { [A]: hit('E'), [B]: hit('N') }, R)
    return [s.players[B].hp, s.players[B].item, s.players[A].item]
  }
  assert.deepEqual(dmg(null, null), [2, null, null])
  assert.deepEqual(dmg('knife', null), [1, null, 'knife'])
  assert.deepEqual(dmg(null, 'shield'), [3, null, null])
  assert.deepEqual(dmg('knife', 'shield'), [2, null, 'knife'])
})

test('shield takes 1 off the total of simultaneous hits, once', () => {
  const s = applyRound(
    st({ [A]: { x: 3, y: 3 }, [B]: { x: 4, y: 3, item: 'shield' }, [C]: { x: 5, y: 3, item: 'knife' } }),
    { [A]: hit('E'), [B]: hit('N'), [C]: hit('W') }, R)
  assert.deepEqual([s.players[B].hp, s.players[B].item], [1, null])
})

test('pickup comes before attacks and replaces the held item; medkit heals to 3', () => {
  let s = applyRound(
    st({ [A]: { x: 3, y: 3, item: 'shield' }, [B]: { x: 4, y: 3 } }, { drops: [{ x: 3, y: 3, item: 'knife' }] }),
    { [A]: { a: 'pickup' }, [B]: hit('W') }, R)
  assert.equal(s.players[A].item, 'knife')
  assert.equal(s.players[A].hp, 2) // the old shield was replaced before the hit
  assert.deepEqual(s.drops, [])

  const med = { drops: [{ x: 3, y: 3, item: 'medkit' as const }] }
  s = applyRound(st({ [A]: { hp: 2, item: 'knife' } }, med), { [A]: { a: 'pickup' } }, R)
  assert.deepEqual([s.players[A].hp, s.players[A].item], [3, 'knife'])
  s = applyRound(st({ [A]: { hp: 3 } }, med), { [A]: { a: 'pickup' } }, R)
  assert.equal(s.players[A].hp, 3)
})

test('storm shrinks at rounds 5, 10, 15 and stops at 2', () => {
  const safeAfter = (done: number) => applyRound(st({ [A]: {} }, { round: done - 1 }), {}, R).safe
  assert.deepEqual([4, 5, 9, 10, 14, 15, 19, 20].map(safeAfter), [8, 6, 6, 4, 4, 2, 2, 2])
})

test('storm does 1 damage outside the zone, in the round it shrinks, through hide and shield', () => {
  const s0 = st({ [A]: { x: 0, y: 3, item: 'shield' }, [B]: { x: 1, y: 3 }, [C]: { x: 6, y: 7 }, [D]: { x: 6, y: 6 } }, { round: 4 })
  const s = applyRound(s0, {}, R)
  assert.deepEqual([A, B, C, D].map(k => s.players[k].hp), [2, 3, 2, 3])
  assert.equal(s.players[A].item, 'shield')
  assert.equal(applyRound({ ...s0, round: 3 }, {}, R).players[A].hp, 3)
  // zone 2 wide is x,y in 3..4
  const s2 = applyRound(st({ [A]: { x: 3, y: 4 }, [B]: { x: 5, y: 4 } }, { round: 14, safe: 4 }), {}, R)
  assert.deepEqual([s2.players[A].hp, s2.players[B].hp], [3, 2])
})

test('supply drop every 3 rounds', () => {
  const dropsAfter = (done: number) => applyRound(st({ [A]: {} }, { round: done - 1 }), {}, R).drops.length
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 9].map(dropsAfter), [0, 0, 1, 0, 0, 1, 0, 1])
  const items = new Set<string>()
  for (let i = 0; i < 40; i++) {
    const [d] = applyRound(st({ [A]: {} }, { round: 2 }), {}, i.toString(16).padStart(64, '0')).drops
    items.add(d.item)
    assert.ok(d.x >= 0 && d.x < 8 && d.y >= 0 && d.y < 8)
  }
  assert.deepEqual([...items].sort(), ['knife', 'medkit', 'shield'])
})

test('supply drop lands on the one free cell, not on a player or a drop', () => {
  const players: Record<string, Partial<P>> = {}
  for (let i = 2; i < 64; i++) players[`p${i}`] = { x: i % 8, y: Math.floor(i / 8) }
  // (0,0) holds a drop, (1,0) is the only empty cell.
  const s0 = st(players, { round: 2, drops: [{ x: 0, y: 0, item: 'knife' }] })
  for (const r of ['00', '11', '22', '33']) {
    const s = applyRound(s0, {}, r.repeat(32))
    assert.equal(s.drops.length, 2)
    assert.deepEqual([s.drops[1].x, s.drops[1].y], [1, 0])
  }
  const full = st({ ...players, q: { x: 1, y: 0 } }, { round: 2, drops: [{ x: 0, y: 0, item: 'knife' }] })
  assert.equal(applyRound(full, {}, R).drops.length, 1) // no free cell: no drop
})

test('legalMove', () => {
  const s = st({ [A]: { x: 0, y: 0 }, [B]: { x: 3, y: 3 }, [C]: { x: 7, y: 7, alive: false, hp: 0 } }, { drops: [{ x: 3, y: 3, item: 'knife' }] })
  assert.equal(legalMove(s, A, go('N')), false)
  assert.equal(legalMove(s, A, go('W')), false)
  assert.equal(legalMove(s, A, go('E')), true)
  assert.equal(legalMove(s, A, go('S')), true)
  assert.equal(legalMove(st({ [A]: { x: 7, y: 7 } }), A, go('E')), false)
  assert.equal(legalMove(st({ [A]: { x: 7, y: 7 } }), A, go('S')), false)
  assert.equal(legalMove(s, A, { a: 'pickup' }), false)
  assert.equal(legalMove(s, B, { a: 'pickup' }), true)
  assert.equal(legalMove(s, A, hit('N')), true) // attacking off-grid is legal and whiffs
  assert.equal(legalMove(s, A, hide), true)
  assert.equal(legalMove(s, C, hide), false)
  assert.equal(legalMove(s, D, hide), false)
  for (const bad of [null, 'hide', {}, { a: 'fly' }, { a: 'move' }, { a: 'move', dir: 'X' }, { a: 'attack', dir: ['N'] }, { a: 'attack', dir: 'constructor' }]) {
    assert.equal(legalMove(s, B, bad as Move), false)
  }
})

test('applyRound treats an illegal move as void', () => {
  const s = applyRound(st({ [A]: { x: 0, y: 0 } }), { [A]: go('N') }, R)
  assert.deepEqual([at(s, A), s.players[A].hiding], [[0, 0], true])
})

test('a dead player is skipped: no move, no attack, no storm', () => {
  const s = applyRound(
    st({ [A]: { x: 0, y: 3, hp: 2, alive: false }, [B]: { x: 1, y: 3 } }, { round: 4 }),
    { [A]: hit('E'), [B]: hit('N') }, R)
  assert.deepEqual([s.players[A].hp, s.players[B].hp], [2, 3])
  assert.deepEqual(s.fallen, [])
})

test('determinism: a whole game replays identically; hash ignores key order', () => {
  const play = () => {
    let s = spawn([A, B, C, D], R)
    const hashes = []
    for (let r = 1; r <= 20; r++) {
      const moves: Record<string, Move> = {}
      for (const [i, k] of [A, B, C, D].entries()) {
        const m = ([go('N'), go('E'), hit('S'), hit('W'), { a: 'pickup' }, hide] as Move[])[(r * 7 + i * 5) % 6]
        moves[k] = legalMove(s, k, m) ? m : hide
      }
      s = applyRound(s, moves, r.toString(16).padStart(64, '0'))
      hashes.push(stateHash(s))
    }
    return { s, hashes }
  }
  assert.deepEqual(play(), play())
  const s = spawn([A, B], R)
  assert.match(stateHash(s), /^[0-9a-f]{64}$/)
  const reordered: State = { fallen: s.fallen, drops: s.drops, players: { [B]: s.players[B], [A]: s.players[A] }, safe: s.safe, round: s.round }
  assert.equal(stateHash(reordered), stateHash(s))
  assert.notEqual(stateHash({ ...s, round: 1 }), stateHash(s))
})

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v) }
  return v
}

test('input is not mutated', () => {
  const s0 = st({
    [A]: { x: 3, y: 3, item: 'knife' }, [B]: { x: 4, y: 3, item: 'shield' }, [C]: { x: 0, y: 0 }, [D]: { x: 6, y: 6 },
  }, { round: 4, drops: [{ x: 3, y: 3, item: 'medkit' }, { x: 6, y: 6, item: 'knife' }] })
  const moves = { [A]: hit('E'), [B]: hit('N'), [C]: go('E'), [D]: { a: 'pickup' } as Move }
  const copy = structuredClone(s0)
  deepFreeze(s0); deepFreeze(moves) // a write throws in module (strict) code
  const s1 = applyRound(s0, moves, R)
  assert.deepEqual(s0, copy)
  assert.notDeepEqual(s1, s0)
  stateHash(s0); winner(s0, R, false); legalMove(s0, A, hide)
  spawn(deepFreeze([D, C, B, A]), R)
})

const tie = (k: string) => bytesToHex(sha256(utf8ToBytes(R + k)))
const lowest = (...ks: string[]) => [...ks].sort((a, b) => (tie(a) < tie(b) ? -1 : 1))[0]

test('winner: one left wins; several left before the limit means no winner yet', () => {
  assert.equal(winner(st({ [A]: {}, [B]: { alive: false, hp: 0 } }), R, false), A)
  assert.equal(winner(st({ [A]: {}, [B]: {} }, { round: 19 }), R, false), null)
})

test('winner: last two die in one round, tie broken by hash; earlier dead cannot win', () => {
  const s = applyRound(
    st({ [A]: { x: 3, y: 3, hp: 1 }, [B]: { x: 4, y: 3, hp: 1 }, [C]: { x: 6, y: 6, hp: 0, alive: false }, [D]: { x: 1, y: 1, hp: 0, alive: false } }),
    { [A]: hit('E'), [B]: hit('W') }, R)
  assert.deepEqual(s.fallen, [A, B])
  assert.equal(winner(s, R, false), lowest(A, B))
  assert.deepEqual(applyRound(s, {}, R).fallen, []) // only the latest round's deaths are kept
})

test('winner: among the last to die, least overkill wins', () => {
  const s = applyRound(
    st({ [A]: { x: 3, y: 3, hp: 1, item: 'knife' }, [B]: { x: 4, y: 3, hp: 1 } }),
    { [A]: hit('E'), [B]: hit('W') }, R)
  assert.deepEqual([s.players[A].hp, s.players[B].hp], [0, -1])
  assert.equal(winner(s, R, false), A)
})

test('winner: a player ejected before the round cannot win the last-die tie break', () => {
  const s = applyRound(
    st({ [A]: { x: 0, y: 3, hp: 3, alive: false }, [B]: { x: 0, y: 5, hp: 1 } }, { round: 4 }),
    {}, R)
  assert.equal(s.players[B].alive, false)
  assert.equal(winner(s, R, false), B)
  const allEjected = applyRound(st({ [A]: { alive: false }, [B]: { x: 5, alive: false } }), {}, R)
  assert.equal(winner(allEjected, R, false), null)
})

test('winner: round limit, highest HP then lowest hash, only among the living', () => {
  const end = { round: 20 }
  assert.equal(winner(st({ [A]: { hp: 1 }, [B]: { hp: 2 }, [C]: { hp: 3, alive: false } }, end), R, true), B)
  assert.equal(winner(st({ [A]: { hp: 2 }, [B]: { hp: 2 }, [C]: { hp: 1 } }, end), R, true), lowest(A, B))
  const other = '77'.repeat(32)
  const hashes = [A, B, C, D].map(k => bytesToHex(sha256(utf8ToBytes(other + k))))
  const want = [A, B, C, D][hashes.indexOf([...hashes].sort()[0])]
  assert.equal(winner(st({ [A]: {}, [B]: {}, [C]: {}, [D]: {} }, end), other, true), want)
})
