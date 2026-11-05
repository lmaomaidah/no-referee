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
