import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runArena } from './arena.ts'
import { gullible, injector, scripted, quitter } from './bots.ts'
import type { Strategy } from './bots.ts'
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

test('chat reaches only its addressee and never touches the result', async () => {
  const heard: Record<string, string[]> = {}
  const talker: Strategy = (s, me, talk) => {
    talk.tell(Object.keys(s.players).sort().find(k => k !== me)!, 'ally with me')
    return scripted(s, me, talk)
  }
  const listener: Strategy = (s, me, talk) => {
    for (const m of talk.inbox) (heard[me] ??= []).push(m.text)
    return scripted(s, me, talk)
  }
  const { log, config, result, keys } = await runArena([talker, listener, listener, listener], { ...red, rounds: 3 })
  assert.equal(result.status, 'finished')
  assert.deepEqual(result.cheats, [])
  assert.deepEqual(Object.keys(heard), [[...keys].sort().find(k => k !== keys[0])])
  assert.ok(Object.values(heard)[0].every(t => t === 'ally with me'))
  assert.ok(!JSON.stringify(log).includes('ally with me'), 'the public log holds only ciphertext')
  assert.deepEqual(verify(log.filter(e => e.kind !== 7304), config).rounds, result.rounds, 'removing chat changes nothing')
})

test('a dead player gets last words once, and the demo transcript records them', async () => {
  const dying: Strategy = (s, me, talk) => {
    if (!talk.dying) return scripted(s, me, talk)
    for (const k of Object.keys(s.players)) if (k !== me && s.players[k].alive) talk.tell(k, 'curse you all')
    return null
  }
  const { chat, keys } = await runArena([scripted, scripted, scripted, dying],
    { ...red, rounds: 4, attacks: { 3: { kind: 'illegal', round: 2 } } })
  assert.equal(chat.length, 3)
  assert.ok(chat.every(m => m.from === keys[3] && m.text === 'curse you all'))
})

test('an injected order reaches a gullible player next round and changes its move, within the rules', async () => {
  const { result, keys } = await runArena([gullible, injector, scripted, scripted], { ...red, rounds: 3 })
  assert.equal(result.rounds[2].moves[keys[0]]?.a, 'hide')
  assert.deepEqual(result.cheats, [], 'being fooled is a bad decision, not a broken rule')
})
