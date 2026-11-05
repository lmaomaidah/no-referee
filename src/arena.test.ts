import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runArena } from './arena.ts'
import { scripted, quitter } from './bots.ts'
import { verify } from './verify.ts'

const fast = { rounds: 20, timeoutMs: 5000, settleMs: 10 }

test('a full game over two relays ends with a winner anyone can recompute', async () => {
  const { log, config, result } = await runArena([scripted, scripted, scripted, scripted], fast)
  assert.equal(result.status, 'finished')
  assert.ok(result.winner)
  assert.deepEqual(result.cheats, [])
  assert.deepEqual(verify(log, config), result)
})

test('a player who quits mid-game is voted out and the game still finishes', async () => {
  const { result, keys } = await runArena([scripted, scripted, scripted, quitter(3)], fast)
  assert.equal(result.status, 'finished')
  assert.deepEqual(result.cheats.map(c => [c.pubkey, c.type, c.round]), [[keys[3], 'absent', 3]])
})

// Red team: player 3 attacks in round 2 of a live game. Patient settle so late copies land.
const red = { rounds: 6, timeoutMs: 5000, settleMs: 300 }
const bots = [scripted, scripted, scripted, scripted]
const caught = [
  ['equivocate', 'equivocation'],
  ['change-move', 'bad-reveal'],
  ['illegal', 'illegal-move'],
  ['lie-state', 'state-fork'],
  ['withhold', 'absent'],
] as const

for (const [kind, type] of caught) {
  test(`attack ${kind} is caught as ${type} and traced to the attacker alone`, async () => {
    const { result, keys } = await runArena(bots, { ...red, attacks: { 3: { kind, round: 2 } } })
    assert.equal(result.status, 'finished')
    assert.deepEqual(result.cheats.map(c => [c.pubkey, c.type, c.round]), [[keys[3], type, 2]])
    assert.ok(result.cheats[0].evidence.length > 0)
  })
}

test('forging another player move changes nothing and nobody is accused', async () => {
  const { result } = await runArena(bots, { ...red, attacks: { 3: { kind: 'forge', round: 2 } } })
  assert.equal(result.status, 'finished')
  assert.deepEqual(result.cheats, [])
})

test('a relay that drops most events cannot break the game', async () => {
  let n = 0
  const { result } = await runArena(bots, { ...red, fault: () => (n++ % 4 ? 'drop' : 'pass') })
  assert.equal(result.status, 'finished')
  assert.deepEqual(result.cheats, [])
})
